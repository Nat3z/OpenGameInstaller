import http from 'node:http';
import https from 'node:https';
import axios from 'axios';
import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { Data, Effect } from 'effect';
import { app, BrowserWindow, dialog, ipcMain, net } from 'electron';
import fs from 'fs';
import path, { join } from 'path';
import yauzl, { type ZipFile } from 'yauzl';
import zlib from 'zlib';
import pjson from '../package.json' with { type: 'json' };
import {
  type BleedingEdgeSyncResult,
  GitSyncError,
  syncBleedingEdgeRepo as syncBleedingEdgeGitRepo,
} from './git-sync.js';

class UpdateError extends Data.TaggedError('UpdateError')<{
  readonly message: string;
  readonly phase?: string;
  readonly cause?: unknown;
}> {}

class FileSystemError extends Data.TaggedError('FileSystemError')<{
  readonly message: string;
  readonly operation: string;
  readonly path?: string;
  readonly cause?: unknown;
}> {}

type UpdaterError = UpdateError | FileSystemError | GitSyncError;

const formatCause = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const tryUpdate = <A>(phase: string, operation: () => A) =>
  Effect.try({
    try: operation,
    catch: (cause) => new UpdateError({ message: formatCause(cause), phase }),
  });

const tryUpdatePromise = <A>(
  phase: string,
  operation: (signal: AbortSignal) => PromiseLike<A>
) =>
  Effect.tryPromise({
    try: operation,
    catch: (cause) =>
      new UpdateError({ message: formatCause(cause), phase, cause }),
  });

const tryFileSystem = <A>(
  operation: string,
  filePath: string | undefined,
  evaluate: () => A
): Effect.Effect<A, FileSystemError> =>
  Effect.try({
    try: evaluate,
    catch: (cause) =>
      new FileSystemError({
        message: formatCause(cause),
        operation,
        path: filePath,
        cause,
      }),
  });

const runUpdater = <A>(effect: Effect.Effect<A, UpdaterError>): Promise<A> =>
  Effect.runPromise(effect);

let mainWindow: BrowserWindow | null = null;

function isDev() {
  return !app.isPackaged;
}

let __dirname = isDev()
  ? app.getAppPath() + '/'
  : path.dirname(process.execPath);
if (process.platform === 'linux') {
  // it's most likely sandboxed, so just use ./
  __dirname = './';
}
console.log(__dirname);
const SETUP_VERSION = pjson.version;
fs.writeFile(join(__dirname, 'updater-version.txt'), SETUP_VERSION, () => {
  console.log('Wrote version file');
});
process.noAsar = true;

function correctParsingSize(size: number) {
  if (size < 1024) {
    return size + 'B';
  } else if (size < 1024 * 1024) {
    return (size / 1024).toFixed(2) + 'KB';
  } else if (size < 1024 * 1024 * 1024) {
    return (size / (1024 * 1024)).toFixed(2) + 'MB';
  } else {
    return (size / (1024 * 1024 * 1024)).toFixed(2) + 'GB';
  }
}

let localVersion = '0.0.0';
let usingBleedingEdge = false;
let updateChannel = 'stable';
if (fs.existsSync(`./version.txt`)) {
  localVersion = fs.readFileSync(`./version.txt`, 'utf8');
}
if (fs.existsSync(`./bleeding-edge.txt`)) {
  updateChannel = 'unstable';
  usingBleedingEdge = true;
}
if (fs.existsSync(`./COMMIT_EDGE.txt`)) {
  updateChannel = 'bleeding-edge';
}

const PATCH_PROGRESS_INTERVAL = 128;
const VERIFY_PROGRESS_INTERVAL = 128;
const RANGE_DOWNLOAD_CHUNK_SIZE = 16 * 1024 * 1024;
const RANGE_DOWNLOAD_CONCURRENCY = 6;
const RANGE_DOWNLOAD_COALESCE_GAP = 512 * 1024;
const PATCH_DOWNLOAD_PROGRESS_INTERVAL_MS = 100;
const HTTP_RETRY_ATTEMPTS = 4;
const HTTP_RETRY_BASE_DELAY_MS = 1500;
const HTTP_REQUEST_TIMEOUT_MS = 60000;
const PRESERVED_UPDATE_ENTRIES = new Set(['artifacts', 'latest.log', 'logs']);
const OGI_REPO_URL = 'https://github.com/Nat3z/OpenGameInstaller';
const ALL_ORIGIN_HEADS_REFSPEC = '+refs/heads/*:refs/remotes/origin/*';
const HTTP_RANGE_AGENTS = {
  http: new http.Agent({
    keepAlive: true,
    maxSockets: RANGE_DOWNLOAD_CONCURRENCY,
  }),
  https: new https.Agent({
    keepAlive: true,
    maxSockets: RANGE_DOWNLOAD_CONCURRENCY,
  }),
};

function getRequestedOnlineState(argv = process.argv) {
  const onlineArg = argv.find((arg) => arg.startsWith('--online='));
  if (!onlineArg) {
    return null;
  }

  const value = onlineArg.slice('--online='.length).trim().toLowerCase();
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }

  return null;
}

function hasArg(name, argv = process.argv) {
  return argv.includes(name);
}

const DEFAULT_BLEEDING_EDGE_BRANCH = 'main';

type CommitEdgeTarget = { branch: string; commit: string; built: string };

function parseCommitEdgeFile(contents: string): CommitEdgeTarget {
  const lines = contents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  let branch = DEFAULT_BLEEDING_EDGE_BRANCH;
  let commit = '';
  let built = '';
  for (const line of lines) {
    const branchMatch = line.match(/^branch=(.+)$/i);
    const commitMatch = line.match(/^commit=(.*)$/i);
    const builtMatch = line.match(/^built=(.+)$/i);
    if (branchMatch) {
      branch = branchMatch[1].trim() || DEFAULT_BLEEDING_EDGE_BRANCH;
      continue;
    }
    if (commitMatch) {
      commit = commitMatch[1].trim();
      continue;
    }
    if (builtMatch) {
      built = builtMatch[1].trim();
      continue;
    }
    if (!commit) {
      commit = line;
    }
  }
  return { branch, commit, built };
}

function writeCommitEdgeFile(branch: string, commit: string, built = '') {
  const lines = [`branch=${branch || DEFAULT_BLEEDING_EDGE_BRANCH}`];
  if (commit) {
    lines.push(`commit=${commit}`);
  } else if (built) {
    lines.push(`built=${built}`);
  }
  fs.writeFileSync('./COMMIT_EDGE.txt', `${lines.join('\n')}\n`);
}

function getBleedingEdgeArtifactPath() {
  return process.platform === 'win32'
    ? path.join(__dirname, 'update', 'OpenGameInstaller.exe')
    : path.join(__dirname, 'update', 'OpenGameInstaller.AppImage');
}

function readStoredCommitEdgeTarget(): CommitEdgeTarget | null {
  if (!fs.existsSync('./COMMIT_EDGE.txt')) {
    return null;
  }
  return parseCommitEdgeFile(fs.readFileSync('./COMMIT_EDGE.txt', 'utf8'));
}

function getRepoHeadSha(repoDir: string): Effect.Effect<string, GitSyncError> {
  return runCommand('git', ['rev-parse', 'HEAD'], {
    cwd: repoDir,
    quiet: true,
  }).pipe(
    Effect.map(({ stdout }) => stdout.trim()),
    Effect.mapError(
      (cause) =>
        new GitSyncError({
          message: cause.message,
          operation: 'resolve-head',
          cause,
        })
    )
  );
}

function shouldSkipBranchOnlyBleedingEdgeBuild(
  targetBranch: string,
  headSha: string
) {
  const stored = readStoredCommitEdgeTarget();
  const artifactPath = getBleedingEdgeArtifactPath();
  if (!stored || stored.commit || stored.branch !== targetBranch) {
    return false;
  }
  if (!stored.built || stored.built !== headSha) {
    return false;
  }
  return fs.existsSync(artifactPath);
}

function getCommitEdgeTarget(argv = process.argv): CommitEdgeTarget {
  const branchArg = argv.find((arg) => arg.startsWith('--branch='));
  const commitArg = argv.find((arg) => arg.startsWith('--commit='));
  const branch = branchArg
    ? branchArg.slice('--branch='.length).trim() || DEFAULT_BLEEDING_EDGE_BRANCH
    : '';
  const commit = commitArg ? commitArg.slice('--commit='.length).trim() : '';
  if (branch || commit) {
    return {
      branch: branch || DEFAULT_BLEEDING_EDGE_BRANCH,
      commit,
      built: '',
    };
  }
  if (fs.existsSync('./COMMIT_EDGE.txt')) {
    return parseCommitEdgeFile(fs.readFileSync('./COMMIT_EDGE.txt', 'utf8'));
  }
  return { branch: DEFAULT_BLEEDING_EDGE_BRANCH, commit: '', built: '' };
}

function getBleedingEdgeRepoDir() {
  if (process.platform === 'win32') {
    return path.join(app.getPath('appData'), 'ogi-repo');
  }
  return path.join(app.getPath('home'), '.local', 'share', 'ogi-repo');
}

function getApplicationBuildCommand(): [string, string[]] {
  return process.platform === 'win32'
    ? ['bun', ['run', '--cwd', 'application', 'electron-pack']]
    : ['bun', ['run', '--cwd', 'application', 'electron-pack:linux']];
}

type CommandResult = { stdout: string; stderr: string };
type RunCommandOptions = {
  cwd?: string;
  /** Skip UI status updates (e.g. git metadata for branch/commit picker). */
  quiet?: boolean;
};

function runCommand(
  command: string,
  args: string[],
  options: RunCommandOptions = {}
): Effect.Effect<CommandResult, UpdateError> {
  const { quiet = false, ...spawnOptions } = options;

  return Effect.async<CommandResult, UpdateError>((resume) => {
    logUpdater(`Running command: ${command} ${args.join(' ')}`);
    const child = spawn(command, args, {
      ...spawnOptions,
      shell: process.platform === 'win32',
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (effect: Effect.Effect<CommandResult, UpdateError>) => {
      if (!settled) {
        settled = true;
        resume(effect);
      }
    };
    child.stdout?.on('data', (data) => {
      const text = data.toString();
      stdout += text;
      if (!quiet) {
        sendUpdaterStatus(
          'Building Bleeding Edge',
          undefined,
          undefined,
          text.trim().slice(-80)
        );
      }
    });
    child.stderr?.on('data', (data) => {
      const text = data.toString();
      stderr += text;
      if (!quiet) {
        sendUpdaterStatus(
          'Building Bleeding Edge',
          undefined,
          undefined,
          text.trim().slice(-80)
        );
      }
    });
    child.once('error', (cause) =>
      finish(
        Effect.fail(
          new UpdateError({
            message: formatCause(cause),
            phase: 'run-command',
            cause,
          })
        )
      )
    );
    child.once('close', (code) =>
      finish(
        code === 0
          ? Effect.succeed({ stdout, stderr })
          : Effect.fail(
              new UpdateError({
                message: `${command} exited with code ${code}`,
                phase: 'run-command',
              })
            )
      )
    );

    return Effect.sync(() => {
      if (!settled && child.exitCode === null) {
        child.kill();
      }
    });
  });
}

function syncBleedingEdgeRepo(
  repoDir: string,
  branch: string
): Effect.Effect<BleedingEdgeSyncResult, GitSyncError> {
  return syncBleedingEdgeGitRepo(
    repoDir,
    branch,
    DEFAULT_BLEEDING_EDGE_BRANCH,
    (command, args, options) =>
      runCommand(command, args, options).pipe(
        Effect.mapError(
          (cause) =>
            new GitSyncError({
              message: cause.message,
              operation: 'fetch',
              cause,
            })
        )
      ),
    getRepoHeadSha
  );
}

/** Match .github/workflows/build-release.yml after hoisted `bun install`. */
function syncHoistedElectronPackages(repoDir: string) {
  return Effect.gen(function* () {
    const rootElectron = path.join(repoDir, 'node_modules', 'electron');
    const electronExists = yield* tryUpdate('sync-electron', () =>
      fs.existsSync(rootElectron)
    );
    if (!electronExists) {
      return yield* Effect.fail(
        new UpdateError({
          message: 'electron not found in repo root node_modules after install',
          phase: 'sync-electron',
        })
      );
    }
    yield* tryUpdate('sync-electron', () => {
      for (const pkg of ['application', 'updater'] as const) {
        const dest = path.join(repoDir, pkg, 'node_modules', 'electron');
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.rmSync(dest, { recursive: true, force: true });
        fs.cpSync(rootElectron, dest, { recursive: true });
      }
    });
  });
}

function ensureBleedingEdgeBuild(
  commit = '',
  branch = DEFAULT_BLEEDING_EDGE_BRANCH
) {
  return Effect.gen(function* () {
    const repoDir = getBleedingEdgeRepoDir();
    const targetBranch = branch || DEFAULT_BLEEDING_EDGE_BRANCH;
    sendUpdaterStatus('Preparing Bleeding Edge');
    let syncResult: BleedingEdgeSyncResult | null = null;
    if (!fs.existsSync(path.join(repoDir, '.git'))) {
      yield* tryUpdate('clone-repository', () =>
        fs.rmSync(repoDir, { recursive: true, force: true })
      );
      yield* runCommand('git', [
        'clone',
        '--branch',
        targetBranch,
        OGI_REPO_URL,
        repoDir,
      ]).pipe(
        Effect.mapError(
          (cause) =>
            new UpdateError({
              message: cause.message,
              phase: 'clone-repository',
              cause,
            })
        )
      );
    } else {
      syncResult = yield* syncBleedingEdgeRepo(repoDir, targetBranch);
    }
    if (commit) {
      yield* runCommand('git', ['checkout', commit], { cwd: repoDir }).pipe(
        Effect.mapError(
          (cause) =>
            new UpdateError({
              message: cause.message,
              phase: 'checkout-commit',
              cause,
            })
        )
      );
    }

    const headSha = yield* getRepoHeadSha(repoDir);
    if (
      !commit &&
      syncResult?.syncWasNoop &&
      shouldSkipBranchOnlyBleedingEdgeBuild(targetBranch, headSha)
    ) {
      sendUpdaterStatus(
        'Bleeding Edge up to date',
        undefined,
        undefined,
        'Skipping build'
      );
      yield* tryUpdate('write-commit-state', () =>
        writeCommitEdgeFile(targetBranch, '', headSha)
      );
      return;
    }

    yield* runCommand('bun', ['install', '--linker=hoisted'], {
      cwd: repoDir,
    });
    yield* syncHoistedElectronPackages(repoDir);
    yield* runCommand('bun', ['run', 'build'], { cwd: repoDir });
    const [buildCommand, buildArgs] = getApplicationBuildCommand();
    yield* runCommand(buildCommand, buildArgs, { cwd: repoDir });

    const destRoot = path.join(__dirname, 'update');
    yield* tryUpdate('prepare-update', () =>
      prepareUpdateDestination(destRoot)
    );
    if (process.platform === 'win32') {
      const exe = yield* tryUpdate('find-build', () =>
        findFirstFile(
          path.join(repoDir, 'application', 'dist'),
          (name) =>
            name.toLowerCase().endsWith('.exe') &&
            !name.toLowerCase().includes('setup')
        )
      );
      if (!exe) {
        return yield* Effect.fail(
          new UpdateError({
            message: 'Built Windows executable not found',
            phase: 'find-build',
          })
        );
      }
      yield* tryUpdate('copy-build', () =>
        fs.copyFileSync(exe, path.join(destRoot, 'OpenGameInstaller.exe'))
      );
    } else {
      const appImage = yield* tryUpdate('find-build', () =>
        findFirstFile(path.join(repoDir, 'application', 'dist'), (name) =>
          name.toLowerCase().endsWith('.appimage')
        )
      );
      if (!appImage) {
        return yield* Effect.fail(
          new UpdateError({
            message: 'Built Linux AppImage not found',
            phase: 'find-build',
          })
        );
      }
      yield* tryUpdate('copy-build', () => {
        fs.copyFileSync(
          appImage,
          path.join(destRoot, 'OpenGameInstaller.AppImage')
        );
        fs.chmodSync(path.join(destRoot, 'OpenGameInstaller.AppImage'), '755');
      });
    }
    yield* tryUpdate('write-commit-state', () =>
      writeCommitEdgeFile(targetBranch, commit, commit ? '' : headSha)
    );
  });
}

function parseRemoteBranchName(ref: string): string | null {
  const headPrefix = 'refs/heads/';
  if (ref.startsWith(headPrefix)) {
    return ref.slice(headPrefix.length);
  }
  const originPrefix = 'origin/';
  if (ref.startsWith(originPrefix)) {
    return ref.slice(originPrefix.length);
  }
  return null;
}

function getBranches(): Effect.Effect<string[], UpdateError> {
  const repoDir = getBleedingEdgeRepoDir();
  const remoteBranches = Effect.gen(function* () {
    const { stdout } = yield* runCommand(
      'git',
      ['ls-remote', '--heads', OGI_REPO_URL],
      { quiet: true }
    );
    const names = new Set<string>();
    for (const line of stdout.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const tab = trimmed.lastIndexOf('\t');
      if (tab === -1) continue;
      const name = parseRemoteBranchName(trimmed.slice(tab + 1));
      if (name) names.add(name);
    }
    const unique = [...names];
    const others = unique
      .filter((name) => name !== 'main')
      .sort((a, b) => a.localeCompare(b));
    return unique.includes('main') ? ['main', ...others] : others;
  });

  if (!fs.existsSync(path.join(repoDir, '.git'))) {
    return remoteBranches;
  }

  return Effect.gen(function* () {
    yield* runCommand(
      'git',
      ['fetch', '--prune', 'origin', ALL_ORIGIN_HEADS_REFSPEC],
      { cwd: repoDir, quiet: true }
    );
    const { stdout } = yield* runCommand(
      'git',
      [
        'for-each-ref',
        'refs/remotes/origin',
        '--format=%(refname:short)\t%(committerdate:iso8601)',
        '--sort=-committerdate',
      ],
      { cwd: repoDir, quiet: true }
    );
    const datedBranches: { name: string; date: string }[] = [];
    for (const line of stdout.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const tab = trimmed.indexOf('\t');
      const ref = tab === -1 ? trimmed : trimmed.slice(0, tab);
      const date = tab === -1 ? '' : trimmed.slice(tab + 1);
      const name = parseRemoteBranchName(ref);
      if (name && name !== 'HEAD') datedBranches.push({ name, date });
    }
    if (!datedBranches.length) return yield* remoteBranches;
    const others = datedBranches
      .filter((branch) => branch.name !== 'main')
      .map((branch) => branch.name);
    return datedBranches.some((branch) => branch.name === 'main')
      ? ['main', ...others]
      : others;
  }).pipe(
    Effect.catchAll((error) => {
      logUpdater('Local git branch listing failed, using ls-remote:', error);
      return remoteBranches;
    })
  );
}

type RecentCommit = {
  sha: string;
  shortSha: string;
  message: string;
  author: string;
  date: string;
};

function parseGitLogCommits(stdout: string): RecentCommit[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split('\x1f');
      const sha = parts[0] || '';
      const author = parts[1] || 'Unknown';
      const date = parts[2] || '';
      const message = parts.slice(3).join('\x1f') || 'No commit message';
      return {
        sha,
        shortSha: sha.slice(0, 7),
        message: message.split('\n')[0] || 'No commit message',
        author,
        date,
      };
    })
    .filter((commit) => commit.sha);
}

function getRecentCommits(
  branch = DEFAULT_BLEEDING_EDGE_BRANCH
): Effect.Effect<RecentCommit[], UpdaterError> {
  const targetBranch = branch || DEFAULT_BLEEDING_EDGE_BRANCH;
  const logFormat = '%H%x1f%an%x1f%cI%x1f%s';
  const repoDir = getBleedingEdgeRepoDir();

  const cloneAndRead = Effect.acquireUseRelease(
    tryFileSystem('remove-temporary-repository', undefined, () => {
      const tmpDir = path.join(
        app.getPath('temp'),
        `ogi-updater-commits-${process.pid}-${Date.now()}`
      );
      fs.rmSync(tmpDir, { recursive: true, force: true });
      return tmpDir;
    }),
    (tmpDir) =>
      Effect.gen(function* () {
        yield* runCommand(
          'git',
          [
            'clone',
            '--depth',
            '12',
            '--branch',
            targetBranch,
            '--single-branch',
            OGI_REPO_URL,
            tmpDir,
          ],
          { quiet: true }
        );
        const { stdout } = yield* runCommand(
          'git',
          ['log', 'HEAD', '-12', `--format=${logFormat}`],
          { cwd: tmpDir, quiet: true }
        );
        return parseGitLogCommits(stdout);
      }),
    (tmpDir) =>
      tryFileSystem('remove-temporary-repository', tmpDir, () =>
        fs.rmSync(tmpDir, { recursive: true, force: true })
      ).pipe(Effect.orElseSucceed(() => undefined))
  );

  if (!fs.existsSync(path.join(repoDir, '.git'))) {
    return cloneAndRead;
  }

  return Effect.gen(function* () {
    yield* runCommand(
      'git',
      [
        'fetch',
        'origin',
        `+refs/heads/${targetBranch}:refs/remotes/origin/${targetBranch}`,
        '--depth',
        '12',
      ],
      { cwd: repoDir, quiet: true }
    );
    const { stdout } = yield* runCommand(
      'git',
      ['log', `origin/${targetBranch}`, '-12', `--format=${logFormat}`],
      { cwd: repoDir, quiet: true }
    );
    const commits = parseGitLogCommits(stdout);
    return commits.length ? commits : yield* cloneAndRead;
  });
}

ipcMain.handle('get-branches', async () => {
  try {
    const branches = await runUpdater(getBranches());
    logUpdater('Loaded branches via git');
    return { ok: true, branches };
  } catch (error) {
    console.error('Failed to load branches via git:', error);
    return {
      ok: false,
      branches: [DEFAULT_BLEEDING_EDGE_BRANCH],
      error: (error as Error)?.message || 'Failed to load branches',
    };
  }
});

ipcMain.handle('get-recent-commits', async (_event, branch) => {
  const targetBranch =
    typeof branch === 'string' && branch
      ? branch
      : DEFAULT_BLEEDING_EDGE_BRANCH;
  try {
    const commits = await runUpdater(getRecentCommits(targetBranch));
    logUpdater('Loaded commits via git');
    return { ok: true, commits };
  } catch (error) {
    console.error('Failed to load recent commits via git:', error);
    return {
      ok: false,
      commits: [],
      error: (error as Error)?.message || 'Failed to load commits',
    };
  }
});

function findFirstFile(root, predicate) {
  if (!fs.existsSync(root)) return null;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const found = findFirstFile(fullPath, predicate);
      if (found) return found;
    } else if (predicate(entry.name, fullPath)) {
      return fullPath;
    }
  }
  return null;
}

function getEffectiveOnlineState(requestedOnline = getRequestedOnlineState()) {
  const networkOnline = net.isOnline();

  if (!networkOnline) {
    return {
      requestedOnline,
      networkOnline,
      effectiveOnline: false,
      reason: 'network-offline',
    };
  }

  if (requestedOnline === false) {
    return {
      requestedOnline,
      networkOnline,
      effectiveOnline: false,
      reason: 'cli-offline',
    };
  }

  return {
    requestedOnline,
    networkOnline,
    effectiveOnline: true,
    reason: 'online',
  };
}

function parseReleaseVersion(tagName) {
  if (typeof tagName !== 'string') {
    return null;
  }

  const match = tagName
    .trim()
    .replace(/^v/i, '')
    .match(
      /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/
    );
  if (!match) {
    return null;
  }

  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

function comparePrereleaseIdentifier(a, b) {
  const aIsNumeric = /^\d+$/.test(a);
  const bIsNumeric = /^\d+$/.test(b);

  if (aIsNumeric && bIsNumeric) {
    const aNumber = Number.parseInt(a, 10);
    const bNumber = Number.parseInt(b, 10);
    if (aNumber > bNumber) return 1;
    if (aNumber < bNumber) return -1;
    return 0;
  }

  if (aIsNumeric) return -1;
  if (bIsNumeric) return 1;
  if (a > b) return 1;
  if (a < b) return -1;
  return 0;
}

function compareParsedReleaseVersion(a, b) {
  if (a.major !== b.major) return a.major > b.major ? 1 : -1;
  if (a.minor !== b.minor) return a.minor > b.minor ? 1 : -1;
  if (a.patch !== b.patch) return a.patch > b.patch ? 1 : -1;

  const aHasPrerelease = a.prerelease.length > 0;
  const bHasPrerelease = b.prerelease.length > 0;
  if (!aHasPrerelease && !bHasPrerelease) return 0;
  if (!aHasPrerelease) return 1;
  if (!bHasPrerelease) return -1;

  const maxLength = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < maxLength; i++) {
    const aIdentifier = a.prerelease[i];
    const bIdentifier = b.prerelease[i];
    if (aIdentifier === undefined) return -1;
    if (bIdentifier === undefined) return 1;

    const identifierOrder = comparePrereleaseIdentifier(
      aIdentifier,
      bIdentifier
    );
    if (identifierOrder !== 0) {
      return identifierOrder;
    }
  }

  return 0;
}

function compareReleaseOrder(a: any, b: any) {
  const parsedA = parseReleaseVersion(a?.tag_name);
  const parsedB = parseReleaseVersion(b?.tag_name);

  if (parsedA && parsedB) {
    const semanticOrder = compareParsedReleaseVersion(parsedB, parsedA);
    if (semanticOrder !== 0) {
      return semanticOrder;
    }
  }

  return (
    new Date(b?.published_at || b?.created_at || 0).getTime() -
    new Date(a?.published_at || a?.created_at || 0).getTime()
  );
}

function sendUpdaterStatus(
  text: string,
  progress?: number,
  max?: number,
  subtext?: string
) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.webContents.send('text', text, progress, max, subtext);
}

function prepareUpdateDestination(destRoot: string) {
  fs.mkdirSync(destRoot, { recursive: true });
  for (const entry of fs.readdirSync(destRoot)) {
    if (PRESERVED_UPDATE_ENTRIES.has(entry)) {
      continue;
    }
    fs.rmSync(path.join(destRoot, entry), { recursive: true, force: true });
  }
}

function nextUiTick() {
  return Effect.yieldNow();
}

function logUpdater(message: string, ...args: unknown[]) {
  console.log(`[updater] ${message}`, ...args);
}

function sleep(ms: number) {
  return Effect.sleep(ms);
}

function getRetryDelay(attempt: number) {
  return HTTP_RETRY_BASE_DELAY_MS * attempt;
}

function shouldRetryHttpError(error: any) {
  const code = error?.code;
  const message =
    typeof error?.message === 'string' ? error.message.toLowerCase() : '';
  const status = error?.response?.status;

  if ([408, 409, 425, 429, 500, 502, 503, 504].includes(status)) {
    return true;
  }

  return (
    code === 'ECONNRESET' ||
    code === 'ECONNABORTED' ||
    code === 'ETIMEDOUT' ||
    code === 'EPIPE' ||
    message.includes('socket hang up') ||
    message.includes('network error') ||
    message.includes('timeout')
  );
}

function getAxiosTransportOptions(url: string) {
  if (typeof url !== 'string') {
    return {};
  }
  if (url.startsWith('https://')) {
    return { httpsAgent: HTTP_RANGE_AGENTS.https };
  }
  if (url.startsWith('http://')) {
    return { httpAgent: HTTP_RANGE_AGENTS.http };
  }
  return {};
}

/**
 * Create and display the updater window, ensure no other instance is running, and handle update checking, download, installation, and app launch.
 *
 * This function:
 * - Verifies that no other instance is serving on localhost:7654 and exits if one is found.
 * - Creates the frameless updater BrowserWindow and prevents DevTools from opening.
 * - If the device is offline, notifies the UI and launches OpenGameInstaller in offline mode.
 * - When online, queries GitHub Releases for a newer release (respecting bleeding-edge prerelease selection), and either:
 *   - Uses a cached release if present and valid, copying files into ./update and writing ./version.txt, or
 *   - Downloads the appropriate platform asset, reports progress to the UI, extracts or places files into ./update (and a temp cache), writes ./version.txt, adjusts execution permissions on Linux, and then launches OpenGameInstaller.
 * - Falls back to launching the existing installed version if update operations fail or no update is found.
 *
 * Side effects:
 * - Creates and writes files under the app directory (e.g., ./update, ./version.txt) and the OS temp directory for caches.
 * - May spawn the OpenGameInstaller process and exit the host app.
 * - Sends status messages to the renderer via mainWindow.webContents.send.
 */
function createWindow(): Effect.Effect<void, UpdaterError> {
  return Effect.gen(function* () {
    // check if port 7654 is open, if not, start the server
    const portCheck = yield* Effect.either(
      tryUpdatePromise('check-running-instance', (signal) =>
        fetch('http://localhost:7654', { signal })
      )
    );
    if (portCheck._tag === 'Right' && portCheck.right.ok) {
      console.error(
        'Port 7654 is already in use, meaning OpenGameInstaller is already running. Exiting.'
      );
      dialog.showErrorBox(
        'OpenGameInstaller is already running',
        'OpenGameInstaller is already running. Please close the other instance before launching OpenGameInstaller again.'
      );
      app.exit(1);
      return;
    }
    if (portCheck._tag === 'Left') {
      console.log("Port isn't in use! Launching....");
    }

    mainWindow = new BrowserWindow({
      width: 300,
      height: 400,
      frame: false,
      resizable: false,
      webPreferences: {
        preload: isDev()
          ? `${app.getAppPath()}/dist/preload.js`
          : `${app.getAppPath()}/dist/preload.js`,
        nodeIntegration: true,
        devTools: false,
        contextIsolation: true,
      },
    });
    yield* tryUpdatePromise('load-updater-window', () =>
      mainWindow.loadURL(`file://${app.getAppPath()}/public/index.html`)
    );
    mainWindow.on('closed', () => {
      mainWindow = null;
    });
    // disable opening devtools
    mainWindow.webContents.on('devtools-opened', () => {
      mainWindow.webContents.closeDevTools();
    });

    const initialOnlineState = getEffectiveOnlineState();
    if (!initialOnlineState.effectiveOnline) {
      console.log(
        initialOnlineState.reason === 'cli-offline'
          ? 'Updater requested offline mode, skipping update check'
          : 'Device is offline, skipping update check'
      );
      mainWindow.webContents.send(
        'text',
        'Launching OpenGameInstaller',
        'Offline Mode'
      );
      launchApp(false);
      return;
    }

    if (hasArg('--gui')) {
      mainWindow.webContents.send('show-channel-picker');
      const choice: any = yield* tryUpdatePromise(
        'choose-update-channel',
        () =>
          new Promise((resolve) => {
            ipcMain.once('choose-channel', (_event, payload) =>
              resolve(payload)
            );
          })
      );
      const channel = choice?.channel || 'stable';
      if (channel === 'stable') {
        yield* tryFileSystem('select-stable-channel', undefined, () => {
          fs.rmSync('./bleeding-edge.txt', { force: true });
          fs.rmSync('./COMMIT_EDGE.txt', { force: true });
        });
        usingBleedingEdge = false;
      } else if (channel === 'unstable') {
        yield* tryFileSystem('select-unstable-channel', undefined, () => {
          fs.writeFileSync('./bleeding-edge.txt', 'true');
          fs.rmSync('./COMMIT_EDGE.txt', { force: true });
        });
        usingBleedingEdge = true;
      } else if (channel === 'bleeding-edge') {
        const buildResult = yield* Effect.either(
          ensureBleedingEdgeBuild(
            (choice?.commit || '').trim(),
            (choice?.branch || DEFAULT_BLEEDING_EDGE_BRANCH).trim()
          )
        );
        if (buildResult._tag === 'Left') {
          console.error(buildResult.left);
          mainWindow.webContents.send(
            'text',
            'Bleeding Edge Failed',
            buildResult.left.message
          );
        } else {
          mainWindow.webContents.send('text', 'Launching OpenGameInstaller');
        }
        launchApp(true);
        return;
      }
    } else if (updateChannel === 'bleeding-edge') {
      const { branch, commit } = getCommitEdgeTarget();
      const buildResult = yield* Effect.either(
        ensureBleedingEdgeBuild(commit, branch)
      );
      if (buildResult._tag === 'Left') {
        console.error(buildResult.left);
        mainWindow.webContents.send(
          'text',
          'Bleeding Edge Failed',
          buildResult.left.message
        );
      } else {
        mainWindow.webContents.send('text', 'Launching OpenGameInstaller');
      }
      launchApp(true);
      return;
    }

    const gitRepo = 'Nat3z/OpenGameInstaller';
    const releaseResult = yield* Effect.either(
      tryUpdatePromise('check-for-updates', (signal) =>
        axios.get(`https://api.github.com/repos/${gitRepo}/releases`, {
          signal,
          timeout: 10000,
        })
      )
    );
    if (releaseResult._tag === 'Left') {
      console.error(releaseResult.left);
      const onlineState = getEffectiveOnlineState();
      mainWindow.webContents.send(
        'text',
        'Launching OpenGameInstaller',
        onlineState.effectiveOnline
          ? 'Failed to check for updates'
          : 'Offline Mode'
      );
      launchApp(onlineState.effectiveOnline);
      return;
    }

    mainWindow.webContents.send('text', 'Checking for Updates');
    const releases = releaseResult.right.data
      .filter((rel) => usingBleedingEdge || !rel.prerelease)
      .sort(compareReleaseOrder);
    const localIndex = releases.findIndex(
      (rel) => rel.tag_name === localVersion
    );
    const targetRelease = releases[0];
    const updating = Boolean(targetRelease) && localIndex !== 0;
    if (targetRelease && updating) {
      const releasePath =
        localIndex > 0
          ? releases.slice(0, localIndex).reverse()
          : [targetRelease];
      const gap =
        localIndex > 0 ? releasePath.length : Number.POSITIVE_INFINITY;
      let updateApplied = false;

      if (Number.isFinite(gap) && gap > 0 && gap <= 3) {
        mainWindow.webContents.send(
          'text',
          'Preparing incremental update path'
        );
        const patchResult = yield* Effect.either(
          applyBlockmapPath(releasePath, releases)
        );
        if (patchResult._tag === 'Right') {
          updateApplied = true;
        } else {
          console.error(
            'Incremental patching failed, falling back:',
            patchResult.left
          );
          mainWindow.webContents.send(
            'text',
            'Falling back to full download',
            patchResult.left.message
          );
        }
      } else {
        mainWindow.webContents.send(
          'text',
          'Falling back to full download',
          Number.isFinite(gap)
            ? 'Version too old for incremental update'
            : 'Local version missing from release feed'
        );
      }

      if (!updateApplied) {
        yield* downloadFullRelease(targetRelease);
      }
      yield* tryFileSystem('write-version', './version.txt', () =>
        fs.writeFileSync('./version.txt', targetRelease.tag_name)
      );
      mainWindow.webContents.send('text', 'Launching OpenGameInstaller');
      launchApp(true);
      return;
    }

    mainWindow.webContents.send(
      'text',
      'Launching OpenGameInstaller',
      'No Updates Found'
    );
    launchApp(true);
  });
}

function getVersionCache(tagName) {
  return path.join(
    app.getPath('temp'),
    `ogi-${tagName.replace('v', '')}-cache`
  );
}

function cleanOldVersionCaches(currentTag) {
  const tempRoot = app.getPath('temp');
  if (!fs.existsSync(tempRoot)) {
    return;
  }
  const keepCacheName =
    typeof currentTag === 'string' && currentTag.length > 0
      ? path.basename(getVersionCache(currentTag))
      : null;
  for (const entry of fs.readdirSync(tempRoot)) {
    if (!entry.startsWith('ogi-') || !entry.endsWith('-cache')) {
      continue;
    }
    if (keepCacheName && entry === keepCacheName) {
      continue;
    }
    fs.rmSync(path.join(tempRoot, entry), { recursive: true, force: true });
  }
}

function getPersistentArtifactDir() {
  return path.join(__dirname, 'update', 'artifacts');
}

function getPersistentArtifactPath(assetName) {
  return path.join(getPersistentArtifactDir(), assetName);
}

function persistSourceArtifact(assetName, sourcePath) {
  if (process.platform !== 'win32') {
    return;
  }
  const persistentPath = getPersistentArtifactPath(assetName);
  fs.mkdirSync(path.dirname(persistentPath), { recursive: true });
  fs.copyFileSync(sourcePath, persistentPath);
}

function cleanOldArtifacts(currentAssetName) {
  if (process.platform !== 'win32') {
    return;
  }
  const dir = getPersistentArtifactDir();
  if (!fs.existsSync(dir)) {
    return;
  }
  for (const file of fs.readdirSync(dir)) {
    if (file === currentAssetName) {
      continue;
    }
    fs.rmSync(path.join(dir, file), { recursive: true, force: true });
  }
}

function cleanupAfterUpdate(currentTag, currentAssetName) {
  try {
    cleanOldArtifacts(currentAssetName);
  } catch (err) {
    console.error('Failed to clean old persistent artifacts:', err);
  }
  try {
    cleanOldVersionCaches(currentTag);
  } catch (err) {
    console.error('Failed to clean old temp caches:', err);
  }
}

function getPlatformAsset(release) {
  if (process.platform === 'win32') {
    return release.assets.find(
      (asset) =>
        asset.name.toLowerCase().includes('portable') ||
        asset.name.toLowerCase().includes('portrable')
    );
  }
  return release.assets.find((asset) =>
    asset.name.toLowerCase().includes('linux-pt.appimage')
  );
}

function getBlockmapAsset(release, targetAsset) {
  return release.assets.find(
    (asset) =>
      asset.name.toLowerCase() === `${targetAsset.name.toLowerCase()}.blockmap`
  );
}

function getReleaseByTag(releases, tagName) {
  return releases.find((release) => release.tag_name === tagName);
}

function getBlockKey(checksum, size) {
  return `${checksum}:${size}`;
}

function ensureCachedSourceArtifact(cacheDir, release, asset) {
  return Effect.gen(function* () {
    const sourceArtifactPath = path.join(cacheDir, asset.name);
    if (fs.existsSync(sourceArtifactPath)) {
      return sourceArtifactPath;
    }

    fs.mkdirSync(cacheDir, { recursive: true });

    // On Linux we usually have the currently installed AppImage available locally.
    if (process.platform === 'linux') {
      const installedAppImage = path.join(
        __dirname,
        'update',
        'OpenGameInstaller.AppImage'
      );
      if (fs.existsSync(installedAppImage)) {
        fs.copyFileSync(installedAppImage, sourceArtifactPath);
        return sourceArtifactPath;
      }
    }
    if (process.platform === 'win32') {
      const persistentArtifact = getPersistentArtifactPath(asset.name);
      if (fs.existsSync(persistentArtifact)) {
        fs.copyFileSync(persistentArtifact, sourceArtifactPath);
        return sourceArtifactPath;
      }
      // Compatibility with older updater versions that may have copied archives
      // into ./update directly.
      const legacyArtifact = path.join(__dirname, 'update', asset.name);
      if (fs.existsSync(legacyArtifact)) {
        fs.copyFileSync(legacyArtifact, sourceArtifactPath);
        return sourceArtifactPath;
      }
    }

    yield* downloadToFile(
      asset.browser_download_url,
      sourceArtifactPath,
      `Downloading base artifact ${release.tag_name}`
    );
    persistSourceArtifact(asset.name, sourceArtifactPath);
    return sourceArtifactPath;
  });
}

function ensureCachedBlockmap(cacheDir: string, release: any, asset: any) {
  return Effect.gen(function* () {
    const blockmapAsset = getBlockmapAsset(release, asset);
    if (!blockmapAsset) {
      return yield* Effect.fail(
        new UpdateError({
          message: `Blockmap missing for ${release.tag_name}`,
          phase: 'validate-blockmap',
        })
      );
    }

    const blockmapPath = path.join(cacheDir, `${asset.name}.blockmap`);
    const cached = yield* tryUpdate('inspect-blockmap-cache', () =>
      fs.existsSync(blockmapPath)
    );
    if (cached) {
      return blockmapPath;
    }

    yield* tryUpdate('prepare-blockmap-cache', () =>
      fs.mkdirSync(cacheDir, { recursive: true })
    );
    yield* downloadToFile(
      blockmapAsset.browser_download_url,
      blockmapPath,
      `Downloading blockmap ${release.tag_name}`
    );
    return blockmapPath;
  });
}

function downloadToFile(
  url: string,
  destination: string,
  status: string
): Effect.Effect<void, UpdaterError> {
  const attemptDownload = (
    attempt: number
  ): Effect.Effect<void, UpdaterError> =>
    Effect.gen(function* () {
      logUpdater(`Starting download: ${status}`, { url, destination, attempt });
      yield* tryFileSystem('prepare-download', destination, () =>
        fs.rmSync(destination, { force: true })
      );
      const response = yield* tryUpdatePromise('start-download', (signal) =>
        axios({
          signal,
          url,
          method: 'GET',
          responseType: 'stream',
          timeout: HTTP_REQUEST_TIMEOUT_MS,
          ...getAxiosTransportOptions(url),
        })
      );
      const writer = yield* tryFileSystem('open-download', destination, () =>
        fs.createWriteStream(destination)
      );
      const contentLength = response.headers['content-length'];
      const fileSize =
        contentLength === undefined
          ? undefined
          : Number(
              Array.isArray(contentLength) ? contentLength[0] : contentLength
            );
      const startTime = Date.now();

      yield* Effect.async<void, UpdateError>((resume) => {
        let settled = false;
        const destroyStreams = () => {
          response.data.destroy?.();
          writer.destroy();
        };
        const finish = (effect: Effect.Effect<void, UpdateError>) => {
          if (!settled) {
            settled = true;
            resume(effect);
          }
        };
        const failAfterClose = (effect: Effect.Effect<void, UpdateError>) => {
          if (settled) {
            return;
          }
          settled = true;
          const openStreams = [response.data, writer].filter(
            (stream) => !stream.closed
          );
          let remaining = openStreams.length;
          if (remaining === 0) {
            resume(effect);
            return;
          }
          for (const stream of openStreams) {
            stream.once('close', () => {
              remaining--;
              if (remaining === 0) {
                resume(effect);
              }
            });
          }
          destroyStreams();
        };
        response.data.on('data', () => {
          const elapsedTime = (Date.now() - startTime) / 1000;
          const downloadSpeed = writer.bytesWritten / Math.max(elapsedTime, 1);
          sendUpdaterStatus(
            status,
            writer.bytesWritten,
            Number.isFinite(fileSize) ? fileSize : undefined,
            correctParsingSize(downloadSpeed) + '/s'
          );
        });
        writer.once('finish', () => finish(Effect.void));
        writer.once('error', (cause) =>
          failAfterClose(
            Effect.fail(
              new UpdateError({
                message: formatCause(cause),
                phase: 'write-download',
                cause,
              })
            )
          )
        );
        response.data.once('error', (cause) =>
          failAfterClose(
            Effect.fail(
              new UpdateError({
                message: formatCause(cause),
                phase: 'read-download',
                cause,
              })
            )
          )
        );
        response.data.pipe(writer);

        return Effect.sync(destroyStreams);
      });
      logUpdater(`Finished download: ${status}`, {
        destination,
        bytesWritten: writer.bytesWritten,
        attempt,
      });
    }).pipe(
      Effect.catchAll((error) =>
        Effect.gen(function* () {
          yield* tryFileSystem('clean-failed-download', destination, () =>
            fs.rmSync(destination, { force: true })
          ).pipe(Effect.orElseSucceed(() => undefined));
          const retryable = shouldRetryHttpError(error.cause ?? error);
          logUpdater(`Download attempt failed: ${status}`, {
            destination,
            attempt,
            retryable,
            error: error.message,
          });
          if (!retryable || attempt === HTTP_RETRY_ATTEMPTS) {
            return yield* Effect.fail(error);
          }
          sendUpdaterStatus(
            status,
            undefined,
            undefined,
            `Retrying (${attempt + 1}/${HTTP_RETRY_ATTEMPTS})`
          );
          yield* sleep(getRetryDelay(attempt));
          return yield* attemptDownload(attempt + 1);
        })
      )
    );

  return attemptDownload(1);
}

function copyCacheToUpdate(cacheDir: string) {
  const files = fs.readdirSync(cacheDir);
  const destRoot = path.join(__dirname, 'update');
  prepareUpdateDestination(destRoot);
  for (const file of files) {
    const lowerName = file.toLowerCase();
    if (lowerName.endsWith('.blockmap')) {
      continue;
    }
    if (process.platform === 'win32' && lowerName.endsWith('.zip')) {
      continue;
    }
    if (
      process.platform === 'linux' &&
      lowerName.endsWith('.appimage') &&
      lowerName !== 'opengameinstaller.appimage'
    ) {
      continue;
    }
    fs.cpSync(path.join(cacheDir, file), path.join(destRoot, file), {
      force: true,
      recursive: true,
    });
  }
}

function downloadFullRelease(release: any) {
  return Effect.gen(function* () {
    const assetWithPortable = getPlatformAsset(release);
    if (!assetWithPortable) {
      return yield* Effect.fail(
        new UpdateError({
          message: 'No portable asset found for this platform',
          phase: 'validate-release',
        })
      );
    }
    const localCache = getVersionCache(release.tag_name);
    yield* tryUpdate('prepare-release-cache', () =>
      fs.mkdirSync(localCache, { recursive: true })
    );
    const blockmapAsset = getBlockmapAsset(release, assetWithPortable);

    sendUpdaterStatus('Downloading Update');
    const downloadPath =
      process.platform === 'win32'
        ? path.join(__dirname, 'update.zip')
        : './update/OpenGameInstaller.AppImage';
    if (process.platform === 'linux') {
      yield* tryUpdate('prepare-update-directory', () =>
        fs.mkdirSync('./update', { recursive: true })
      );
    }
    yield* downloadToFile(
      assetWithPortable.browser_download_url,
      downloadPath,
      'Downloading Update'
    );
    sendUpdaterStatus('Verifying Download');
    yield* verifyReleaseArtifact(
      downloadPath,
      {
        size: assetWithPortable.size,
        digest: assetWithPortable.digest,
      },
      'downloaded release artifact'
    );
    if (blockmapAsset) {
      yield* downloadToFile(
        blockmapAsset.browser_download_url,
        path.join(localCache, `${assetWithPortable.name}.blockmap`),
        'Downloading blockmap'
      );
    }
    sendUpdaterStatus('Download Complete');

    if (process.platform === 'win32') {
      const zipPath = path.join(__dirname, 'update.zip');
      yield* tryUpdate('persist-release', () =>
        persistSourceArtifact(assetWithPortable.name, zipPath)
      );
      sendUpdaterStatus('Extracting Update');
      yield* unzip(zipPath, localCache);
      sendUpdaterStatus('Copying Update Files');
      yield* tryUpdate('copy-release', () => {
        copyCacheToUpdate(localCache);
        fs.copyFileSync(zipPath, path.join(localCache, assetWithPortable.name));
        fs.unlinkSync(zipPath);
      });
    } else {
      const item = path.join(__dirname, 'update', 'OpenGameInstaller.AppImage');
      yield* tryUpdate('copy-release', () => {
        fs.copyFileSync(
          item,
          path.join(localCache, 'OpenGameInstaller.AppImage')
        );
        fs.copyFileSync(item, path.join(localCache, assetWithPortable.name));
        fs.chmodSync(item, '755');
      });
    }
    yield* tryUpdate('clean-release-cache', () =>
      cleanupAfterUpdate(release.tag_name, assetWithPortable.name)
    );
  });
}

function applyBlockmapPath(releasePath: any, releases: any) {
  return Effect.gen(function* () {
    let currentTag = localVersion;
    let latestAssetName = null;
    logUpdater('Starting incremental update path', {
      from: currentTag,
      steps: releasePath.map((release: any) => release.tag_name),
    });
    for (let i = 0; i < releasePath.length; i++) {
      const currentRelease = getReleaseByTag(releases, currentTag);
      const nextRelease = releasePath[i];
      logUpdater('Applying incremental patch step', {
        step: i + 1,
        totalSteps: releasePath.length,
        from: currentTag,
        to: nextRelease.tag_name,
      });
      sendUpdaterStatus(`Applying patch ${i + 1} of ${releasePath.length}`);
      if (!currentRelease) {
        return yield* Effect.fail(
          new UpdateError({
            message: `Release metadata missing for ${currentTag}`,
            phase: 'validate-patch-path',
          })
        );
      }
      const fromCache = getVersionCache(currentTag);
      const nextCache = getVersionCache(nextRelease.tag_name);
      const currentAsset = getPlatformAsset(currentRelease);
      if (!currentAsset) {
        return yield* Effect.fail(
          new UpdateError({
            message: `Portable asset missing for ${currentTag}`,
            phase: 'validate-patch-path',
          })
        );
      }
      const nextAsset = getPlatformAsset(nextRelease);
      if (!nextAsset) {
        return yield* Effect.fail(
          new UpdateError({
            message: `Portable asset missing for ${nextRelease.tag_name}`,
            phase: 'validate-patch-path',
          })
        );
      }
      latestAssetName = nextAsset.name;
      const newBlockmapAsset = getBlockmapAsset(nextRelease, nextAsset);
      if (!newBlockmapAsset) {
        return yield* Effect.fail(
          new UpdateError({
            message: `Blockmap missing for ${nextRelease.tag_name}`,
            phase: 'validate-patch-path',
          })
        );
      }
      const sourceArtifact = yield* ensureCachedSourceArtifact(
        fromCache,
        currentRelease,
        currentAsset
      );
      sendUpdaterStatus('Verifying base artifact');
      yield* verifyReleaseArtifact(
        sourceArtifact,
        {
          size: currentAsset.size,
          digest: currentAsset.digest,
        },
        'base artifact'
      );
      const oldBlockmapPath = yield* ensureCachedBlockmap(
        fromCache,
        currentRelease,
        currentAsset
      );
      fs.mkdirSync(nextCache, { recursive: true });
      const newBlockmapPath = path.join(
        nextCache,
        `${nextAsset.name}.blockmap`
      );
      if (!fs.existsSync(newBlockmapPath)) {
        yield* downloadToFile(
          newBlockmapAsset.browser_download_url,
          newBlockmapPath,
          'Downloading blockmap'
        );
      }
      const outputArtifact = path.join(nextCache, nextAsset.name);
      logUpdater('Prepared patch inputs', {
        sourceArtifact,
        oldBlockmapPath,
        newBlockmapPath,
        outputArtifact,
      });
      sendUpdaterStatus(
        `Building patch ${i + 1} of ${releasePath.length}`,
        0,
        1,
        nextRelease.tag_name
      );
      yield* nextUiTick();
      yield* applyBlockmapPatch(
        sourceArtifact,
        oldBlockmapPath,
        outputArtifact,
        newBlockmapPath,
        nextAsset.browser_download_url,
        { size: nextAsset.size, digest: nextAsset.digest },
        {
          patchLabel: `Building patch ${i + 1} of ${releasePath.length}`,
          verifyLabel: `Verifying patch ${i + 1} of ${releasePath.length}`,
          releaseTag: nextRelease.tag_name,
        }
      );

      if (process.platform === 'win32') {
        persistSourceArtifact(nextAsset.name, outputArtifact);
        logUpdater('Extracting patched Windows artifact', {
          artifact: outputArtifact,
          destination: nextCache,
        });
        sendUpdaterStatus(
          `Extracting patch ${i + 1} of ${releasePath.length}`,
          0,
          1,
          nextRelease.tag_name
        );
        yield* nextUiTick();
        yield* unzip(outputArtifact, nextCache);
      } else {
        logUpdater('Finalizing patched Linux artifact', {
          artifact: outputArtifact,
          destination: path.join(nextCache, 'OpenGameInstaller.AppImage'),
        });
        sendUpdaterStatus(
          `Finalizing patch ${i + 1} of ${releasePath.length}`,
          0,
          1,
          nextRelease.tag_name
        );
        fs.copyFileSync(
          outputArtifact,
          path.join(nextCache, 'OpenGameInstaller.AppImage')
        );
      }
      currentTag = nextRelease.tag_name;
      logUpdater('Completed incremental patch step', {
        step: i + 1,
        currentTag,
      });
    }
    sendUpdaterStatus('Copying Update Files');
    logUpdater('Copying patched cache into update directory', {
      cache: getVersionCache(releasePath[releasePath.length - 1].tag_name),
    });
    copyCacheToUpdate(
      getVersionCache(releasePath[releasePath.length - 1].tag_name)
    );
    if (process.platform === 'linux') {
      sendUpdaterStatus('Finishing Update');
      fs.chmodSync('./update/OpenGameInstaller.AppImage', '755');
    }
    logUpdater('Incremental update path complete', {
      finalTag: releasePath[releasePath.length - 1].tag_name,
      latestAssetName,
    });
    yield* tryUpdate('clean-patch-cache', () =>
      cleanupAfterUpdate(
        releasePath[releasePath.length - 1].tag_name,
        latestAssetName
      )
    );
  });
}

function applyBlockmapPatch(
  sourceArtifact,
  oldBlockmapPath,
  outputArtifact,
  newBlockmapPath,
  targetUrl,
  expectedArtifact = {},
  statusLabels: any = {}
): Effect.Effect<void, UpdaterError> {
  return Effect.gen(function* () {
    const patchLabel = statusLabels.patchLabel || 'Building patch';
    const verifyLabel = statusLabels.verifyLabel || 'Verifying patch';
    const releaseTag = statusLabels.releaseTag;
    logUpdater('Starting blockmap patch', {
      sourceArtifact,
      oldBlockmapPath,
      newBlockmapPath,
      outputArtifact,
      releaseTag,
    });
    const { oldMap, newMap } = yield* tryUpdate(
      'prepare-blockmap-patch',
      () => ({
        oldMap: JSON.parse(
          zlib.gunzipSync(fs.readFileSync(oldBlockmapPath)).toString('utf8')
        ),
        newMap: JSON.parse(
          zlib.gunzipSync(fs.readFileSync(newBlockmapPath)).toString('utf8')
        ),
      })
    );
    const oldFile = oldMap.files?.[0];
    const newFile = newMap.files?.[0];
    if (!oldFile || !newFile) {
      return yield* Effect.fail(
        new UpdateError({ message: 'Invalid blockmap payload' })
      );
    }
    const checksumToBlocks = yield* tryUpdate('prepare-blockmap-patch', () => {
      const blocksByChecksum = new Map();
      let oldOffset = oldFile.offset || 0;
      for (let i = 0; i < oldFile.checksums.length; i++) {
        const key = getBlockKey(oldFile.checksums[i], oldFile.sizes[i]);
        const block = { offset: oldOffset, size: oldFile.sizes[i] };
        const current = blocksByChecksum.get(key) || [];
        current.push(block);
        blocksByChecksum.set(key, current);
        oldOffset += oldFile.sizes[i];
      }

      fs.mkdirSync(path.dirname(outputArtifact), { recursive: true });
      return blocksByChecksum;
    });
    let sourceFd: number | undefined;
    let outFd: number | undefined;

    try {
      sourceFd = yield* tryUpdate('open-patch-source', () =>
        fs.openSync(sourceArtifact, 'r')
      );
      outFd = yield* tryUpdate('open-patch-output', () =>
        fs.openSync(outputArtifact, 'w')
      );
      let writeOffset = newFile.offset || 0;
      const misses = [];

      if (writeOffset > 0) {
        sendUpdaterStatus(patchLabel, 0, newFile.checksums.length, releaseTag);
        yield* nextUiTick();
        const headerChunk = yield* downloadRangeChunk(
          targetUrl,
          0,
          writeOffset - 1
        );
        yield* tryUpdate('write-patch-header', () =>
          fs.writeSync(outFd, headerChunk, 0, headerChunk.length, 0)
        );
      }

      for (let i = 0; i < newFile.checksums.length; i++) {
        const size = newFile.sizes[i];
        const blocks = checksumToBlocks.get(
          getBlockKey(newFile.checksums[i], size)
        );
        // Consume one old block at most once to avoid reusing source data.
        const matched = takeMatchingBlock(blocks);
        if (matched) {
          const { buffer, bytesRead } = yield* tryUpdate(
            'reuse-patch-block',
            () => {
              const buffer = Buffer.alloc(size);
              const bytesRead = fs.readSync(
                sourceFd,
                buffer,
                0,
                size,
                matched.offset
              );
              return { buffer, bytesRead };
            }
          );
          if (bytesRead !== size) {
            return yield* Effect.fail(
              new UpdateError({
                message: `Short read from source artifact at ${matched.offset}: expected ${size}, got ${bytesRead}`,
              })
            );
          }
          yield* tryUpdate('reuse-patch-block', () =>
            fs.writeSync(outFd, buffer, 0, size, writeOffset)
          );
        } else {
          misses.push({ offset: writeOffset, size });
        }
        writeOffset += size;
        if (
          i === newFile.checksums.length - 1 ||
          (i + 1) % PATCH_PROGRESS_INTERVAL === 0
        ) {
          sendUpdaterStatus(
            patchLabel,
            i + 1,
            newFile.checksums.length,
            releaseTag
          );
          yield* nextUiTick();
        }
      }

      const mergedMisses = [];
      for (const miss of misses) {
        const last = mergedMisses[mergedMisses.length - 1];
        if (last && last.offset + last.size === miss.offset) {
          last.size += miss.size;
        } else {
          mergedMisses.push({ ...miss });
        }
      }

      const totalMissBytes = mergedMisses.reduce(
        (total, miss) => total + miss.size,
        0
      );
      const reusedBytes =
        newFile.sizes.reduce((total, size) => total + size, 0) - totalMissBytes;
      const downloadTasks = createRangeDownloadTasks(mergedMisses);
      const totalScheduledDownloadBytes = downloadTasks.reduce(
        (total, task) => total + task.size,
        0
      );
      logUpdater('Patch block analysis complete', {
        releaseTag,
        blockCount: newFile.checksums.length,
        missingRanges: mergedMisses.length,
        downloadTasks: downloadTasks.length,
        totalMissBytes,
        totalScheduledDownloadBytes,
        reusedBytes,
      });
      yield* downloadMissingPatchRanges(
        targetUrl,
        outFd,
        downloadTasks,
        releaseTag
      );
    } finally {
      if (typeof sourceFd === 'number') {
        try {
          fs.closeSync(sourceFd);
        } catch (closeErr) {
          console.error('Failed to close source file descriptor:', closeErr);
        }
      }
      if (typeof outFd === 'number') {
        try {
          fs.closeSync(outFd);
        } catch (closeErr) {
          console.error('Failed to close output file descriptor:', closeErr);
        }
      }
    }
    const patchIsEmpty = yield* tryUpdate(
      'inspect-patched-artifact',
      () =>
        !fs.existsSync(outputArtifact) || fs.statSync(outputArtifact).size === 0
    );
    if (patchIsEmpty) {
      return yield* Effect.fail(
        new UpdateError({
          message: 'Patched artifact is empty',
          phase: 'inspect-patched-artifact',
        })
      );
    }
    sendUpdaterStatus(verifyLabel, 0, newFile.checksums.length, releaseTag);
    yield* nextUiTick();
    logUpdater('Starting patched artifact verification', {
      outputArtifact,
      releaseTag,
    });
    yield* verifyPatchedArtifact(
      outputArtifact,
      newFile,
      expectedArtifact,
      verifyLabel,
      releaseTag
    );
    logUpdater('Completed blockmap patch', {
      outputArtifact,
      releaseTag,
    });
  });
}

function takeMatchingBlock(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return null;
  }
  return blocks.pop();
}

function createRangeDownloadTasks(misses) {
  if (!Array.isArray(misses) || misses.length === 0) {
    return [];
  }

  const coalescedRanges = [];
  for (const miss of misses) {
    const lastRange = coalescedRanges[coalescedRanges.length - 1];
    const missEnd = miss.offset + miss.size;
    if (!lastRange) {
      coalescedRanges.push({ offset: miss.offset, size: miss.size });
      continue;
    }

    const lastEnd = lastRange.offset + lastRange.size;
    const gap = miss.offset - lastEnd;
    if (gap >= 0 && gap <= RANGE_DOWNLOAD_COALESCE_GAP) {
      lastRange.size = missEnd - lastRange.offset;
      continue;
    }

    coalescedRanges.push({ offset: miss.offset, size: miss.size });
  }

  const tasks = [];
  for (const range of coalescedRanges) {
    let start = range.offset;
    const end = range.offset + range.size - 1;
    while (start <= end) {
      const chunkEnd = Math.min(start + RANGE_DOWNLOAD_CHUNK_SIZE - 1, end);
      tasks.push({
        start,
        end: chunkEnd,
        size: chunkEnd - start + 1,
      });
      start = chunkEnd + 1;
    }
  }
  return tasks;
}

function downloadMissingPatchRanges(
  targetUrl,
  outFd,
  tasks,
  releaseTag
): Effect.Effect<void, UpdateError> {
  return Effect.gen(function* () {
    const totalBytes = tasks.reduce((total, task) => total + task.size, 0);
    if (totalBytes <= 0) {
      sendUpdaterStatus('Downloading patch data', 0, 1, releaseTag);
      return;
    }

    let downloadedBytes = 0;
    let nextTaskIndex = 0;
    let lastProgressAt = 0;

    const reportProgress = (force = false) => {
      const now = Date.now();
      if (
        !force &&
        now - lastProgressAt < PATCH_DOWNLOAD_PROGRESS_INTERVAL_MS
      ) {
        return;
      }
      lastProgressAt = now;
      sendUpdaterStatus(
        'Downloading patch data',
        downloadedBytes,
        totalBytes,
        releaseTag
      );
    };

    reportProgress(true);

    const workerCount = Math.min(RANGE_DOWNLOAD_CONCURRENCY, tasks.length);
    yield* Effect.forEach(
      Array.from({ length: workerCount }),
      () =>
        Effect.gen(function* () {
          while (true) {
            const taskIndex = nextTaskIndex++;
            if (taskIndex >= tasks.length) {
              return;
            }

            const task = tasks[taskIndex];
            logUpdater('Downloading patch data range', {
              releaseTag,
              start: task.start,
              end: task.end,
              size: task.size,
              task: taskIndex + 1,
              totalTasks: tasks.length,
            });

            const chunk = yield* downloadRangeChunk(
              targetUrl,
              task.start,
              task.end
            );
            yield* tryUpdate('write-patch-range', () =>
              fs.writeSync(outFd, chunk, 0, chunk.length, task.start)
            );
            downloadedBytes += chunk.length;

            logUpdater('Downloaded patch data range', {
              releaseTag,
              start: task.start,
              end: task.end,
              chunkSize: chunk.length,
              downloadedBytes,
              totalBytes,
            });
            reportProgress();
          }
        }),
      { concurrency: 'unbounded', discard: true }
    );

    reportProgress(true);
  });
}

function downloadRangeChunk(
  url,
  start,
  end
): Effect.Effect<Buffer, UpdateError> {
  return Effect.gen(function* () {
    const requestedRange = `bytes=${start}-${end}`;
    for (let attempt = 1; attempt <= HTTP_RETRY_ATTEMPTS; attempt++) {
      logUpdater('Requesting HTTP range', { url, requestedRange, attempt });
      const responseResult = yield* Effect.either(
        Effect.tryPromise({
          try: (signal) =>
            axios({
              signal,
              url,
              method: 'GET',
              responseType: 'arraybuffer',
              headers: {
                Range: requestedRange,
                'Accept-Encoding': 'identity',
              },
              timeout: HTTP_REQUEST_TIMEOUT_MS,
              ...getAxiosTransportOptions(url),
            }),
          catch: (cause) => cause,
        })
      );
      if (responseResult._tag === 'Left') {
        const error: any = responseResult.left;
        const retryable = shouldRetryHttpError(error);
        logUpdater('HTTP range request failed', {
          requestedRange,
          attempt,
          retryable,
          error: error?.message,
          code: error?.code,
          statusCode: error?.response?.status,
        });
        if (!retryable || attempt === HTTP_RETRY_ATTEMPTS) {
          return yield* Effect.fail(
            new UpdateError({
              message: formatCause(error),
              phase: 'download-patch-range',
            })
          );
        }
        yield* sleep(getRetryDelay(attempt));
        continue;
      }

      const rangeResponse = responseResult.right;
      const expectedSize = end - start + 1;
      const actualSize = Buffer.byteLength(rangeResponse.data);
      const contentRange = rangeResponse.headers['content-range'];
      const expectedContentRangePrefix = `bytes ${start}-${end}/`;
      if (rangeResponse.status !== 206) {
        return yield* Effect.fail(
          new UpdateError({
            message: `Invalid range response status ${rangeResponse.status} for ${requestedRange}`,
          })
        );
      }
      if (actualSize !== expectedSize) {
        return yield* Effect.fail(
          new UpdateError({
            message: `Invalid range response length ${actualSize} for ${requestedRange}; expected ${expectedSize}`,
          })
        );
      }
      if (
        typeof contentRange !== 'string' ||
        !contentRange.startsWith(expectedContentRangePrefix)
      ) {
        return yield* Effect.fail(
          new UpdateError({
            message: `Invalid content-range header for ${requestedRange}: ${contentRange}`,
          })
        );
      }
      logUpdater('Received HTTP range', {
        requestedRange,
        actualSize,
        contentRange,
        attempt,
      });
      return Buffer.from(rangeResponse.data);
    }

    return yield* Effect.fail(
      new UpdateError({
        message: `Exhausted HTTP range retries for ${requestedRange}`,
        phase: 'download-patch-range',
      })
    );
  });
}

function parseDigest(digest) {
  if (typeof digest !== 'string') {
    return null;
  }
  const [algorithm, value] = digest.split(':', 2);
  if (!algorithm || !value) {
    return null;
  }
  const normalizedAlgorithm = algorithm.toLowerCase();
  if (
    normalizedAlgorithm !== 'sha256' &&
    normalizedAlgorithm !== 'sha384' &&
    normalizedAlgorithm !== 'sha512'
  ) {
    return null;
  }
  return { algorithm: normalizedAlgorithm, value: value.toLowerCase() };
}

function hashFile(filePath, algorithm): Effect.Effect<string, FileSystemError> {
  return Effect.async<string, FileSystemError>((resume) => {
    const hash = createHash(algorithm);
    const stream = fs.createReadStream(filePath);
    stream.once('error', (cause) =>
      resume(
        Effect.fail(
          new FileSystemError({
            message: formatCause(cause),
            operation: 'hash-file',
            path: filePath,
            cause,
          })
        )
      )
    );
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('end', () => resume(Effect.succeed(hash.digest('hex'))));
    return Effect.sync(() => stream.destroy());
  });
}

function verifyReleaseArtifact(
  artifactPath,
  expectedArtifact,
  logLabel = 'release artifact'
): Effect.Effect<void, UpdaterError> {
  return Effect.gen(function* () {
    const stat = yield* tryUpdate('verify-release-artifact', () =>
      fs.statSync(artifactPath)
    );
    if (
      Number.isFinite(expectedArtifact.size) &&
      expectedArtifact.size > 0 &&
      stat.size !== expectedArtifact.size
    ) {
      return yield* Effect.fail(
        new UpdateError({
          message: `${logLabel} size mismatch: expected ${expectedArtifact.size}, got ${stat.size}`,
        })
      );
    }

    const parsedDigest = parseDigest(expectedArtifact.digest);
    if (expectedArtifact.digest && !parsedDigest) {
      logUpdater('Invalid digest format, aborting verification', {
        artifactPath,
        logLabel,
        digest: expectedArtifact.digest,
      });
      return yield* Effect.fail(
        new UpdateError({
          message: `${logLabel} has invalid digest format: ${expectedArtifact.digest}`,
        })
      );
    }
    if (!parsedDigest) {
      logUpdater('No release digest available for artifact verification', {
        artifactPath,
        logLabel,
      });
      return;
    }

    const actualDigest = yield* hashFile(artifactPath, parsedDigest.algorithm);
    if (actualDigest !== parsedDigest.value) {
      return yield* Effect.fail(
        new UpdateError({
          message: `${logLabel} digest mismatch for ${parsedDigest.algorithm}`,
          phase: 'verify-release-artifact',
        })
      );
    }
  });
}

function verifyPatchedArtifact(
  outputArtifact,
  newFile,
  expectedArtifact,
  verifyLabel = 'Verifying patch',
  releaseTag
): Effect.Effect<void, UpdaterError> {
  return Effect.gen(function* () {
    logUpdater('Verifying patched artifact metadata', {
      outputArtifact,
      releaseTag,
    });
    const stat = yield* tryUpdate('verify-patched-artifact', () =>
      fs.statSync(outputArtifact)
    );
    if (
      !Array.isArray(newFile.sizes) ||
      !Array.isArray(newFile.checksums) ||
      newFile.sizes.length !== newFile.checksums.length
    ) {
      return yield* Effect.fail(
        new UpdateError({
          message: 'Invalid blockmap payload for patched artifact',
        })
      );
    }
    const expectedByBlockmap =
      (newFile.offset || 0) +
      newFile.sizes.reduce((total, size) => total + size, 0);
    if (stat.size !== expectedByBlockmap) {
      return yield* Effect.fail(
        new UpdateError({
          message: `Patched artifact size mismatch: expected ${expectedByBlockmap}, got ${stat.size}`,
        })
      );
    }
    if (
      Number.isFinite(expectedArtifact.size) &&
      expectedArtifact.size > 0 &&
      stat.size !== expectedArtifact.size
    ) {
      return yield* Effect.fail(
        new UpdateError({
          message: `Patched artifact does not match expected release size ${expectedArtifact.size}`,
        })
      );
    }

    const fd = yield* tryUpdate('verify-patched-artifact', () =>
      fs.openSync(outputArtifact, 'r')
    );
    try {
      let readOffset = newFile.offset || 0;
      for (let i = 0; i < newFile.checksums.length; i++) {
        const size = newFile.sizes[i];
        if (!Number.isInteger(size) || size < 0) {
          return yield* Effect.fail(
            new UpdateError({
              message: `Invalid block size at index ${i}: ${size}`,
            })
          );
        }
        const buffer = Buffer.alloc(size);
        const bytesRead = yield* tryUpdate('verify-patched-artifact', () =>
          fs.readSync(fd, buffer, 0, size, readOffset)
        );
        if (bytesRead !== size) {
          return yield* Effect.fail(
            new UpdateError({
              message: `Short read from patched artifact at ${readOffset}: expected ${size}, got ${bytesRead}`,
            })
          );
        }
        readOffset += size;
        if (
          i === newFile.checksums.length - 1 ||
          (i + 1) % VERIFY_PROGRESS_INTERVAL === 0
        ) {
          sendUpdaterStatus(
            verifyLabel,
            i + 1,
            newFile.checksums.length,
            releaseTag
          );
          yield* nextUiTick();
        }
      }
    } finally {
      fs.closeSync(fd);
    }
    logUpdater('Completed block-level verification', {
      outputArtifact,
      releaseTag,
      blocks: newFile.checksums.length,
    });

    const parsedDigest = parseDigest(expectedArtifact.digest);
    if (!parsedDigest) {
      logUpdater(
        'No release digest available for final artifact verification',
        {
          outputArtifact,
          releaseTag,
        }
      );
      return;
    }
    const actualDigest = yield* hashFile(
      outputArtifact,
      parsedDigest.algorithm
    );
    if (actualDigest !== parsedDigest.value) {
      return yield* Effect.fail(
        new UpdateError({
          message: `Patched artifact digest mismatch for ${parsedDigest.algorithm}`,
        })
      );
    }
    logUpdater('Completed final artifact digest verification', {
      outputArtifact,
      releaseTag,
      algorithm: parsedDigest.algorithm,
    });
  });
}

/**
 * Launches the installed OpenGameInstaller, rotating logs, spawning the platform-specific executable in a detached process, and terminating the updater.
 *
 * Spawns OpenGameInstaller with `--online=<online>` as an argument.
 * @param {boolean} online - If true, start the application in online mode; otherwise start in offline mode.
 */
function launchApp(online) {
  const effectiveOnline = getEffectiveOnlineState(online).effectiveOnline;
  console.log(
    'Launching in ' + (effectiveOnline ? 'online' : 'offline') + ' mode'
  );
  mainWindow.webContents.send('text', 'Launching OpenGameInstaller');
  if (process.platform === 'win32') {
    if (
      !fs.existsSync(path.join(__dirname, 'update', 'OpenGameInstaller.exe'))
    ) {
      mainWindow.webContents.send(
        'text',
        'Installation not found',
        'Launch Failed'
      );
      return;
    }
    // OpenGameInstaller.exe logs will be written to latest.log in the update directory
    // if there's already a latest.log, move it to the logs/ fodler with the date and time in the name
    if (!fs.existsSync(path.join(__dirname, 'update', 'logs'))) {
      fs.mkdirSync(path.join(__dirname, 'update', 'logs'));
    }
    if (fs.existsSync(path.join(__dirname, 'update', 'latest.log'))) {
      const date = new Date().toISOString().replace(/[:.]/g, '-');
      fs.renameSync(
        path.join(__dirname, 'update', 'latest.log'),
        path.join(__dirname, 'update', 'logs', date + '.log')
      );
    }

    const logStream = fs.openSync(
      path.join(__dirname, 'update', 'latest.log'),
      'a'
    );
    const spawned = spawn(
      './OpenGameInstaller.exe',
      ['--online=' + effectiveOnline],
      {
        cwd: path.join(__dirname, 'update'),
        detached: true,
        stdio: ['ignore', logStream, logStream],
      }
    );
    spawned.unref();
    app.exit(0);
  } else if (process.platform === 'linux') {
    if (
      !fs.existsSync(
        path.join(__dirname, 'update', 'OpenGameInstaller.AppImage')
      )
    ) {
      mainWindow.webContents.send(
        'text',
        'Installation not found',
        'Launch Failed'
      );
      return;
    }
    setTimeout(() => {
      // OpenGameInstaller.AppImage logs will be written to latest.log in the update directory
      // if there's already a latest.log, move it to the logs/ fodler with the date and time in the name
      if (!fs.existsSync(path.join(__dirname, 'update', 'logs'))) {
        fs.mkdirSync(path.join(__dirname, 'update', 'logs'));
      }
      if (fs.existsSync(path.join(__dirname, 'update', 'latest.log'))) {
        const date = new Date().toISOString().replace(/[:.]/g, '-');
        fs.renameSync(
          path.join(__dirname, 'update', 'latest.log'),
          path.join(__dirname, 'update', 'logs', date + '.log')
        );
      }
      const logStream = fs.openSync(
        path.join(__dirname, 'update', 'latest.log'),
        'a'
      );

      // --no-sandbox is needed to run the appimage in Steam Deck Game Mode
      const spawned = spawn(
        './OpenGameInstaller.AppImage',
        ['--online=' + effectiveOnline, '--no-sandbox'],
        {
          cwd: path.join(__dirname, 'update'),
          detached: true,
          stdio: ['ignore', logStream, logStream],
        }
      );
      spawned.unref();
      app.exit(0);
    }, 200);
  }
}

function resolveZipEntryPath(unzipToDir, entryName): string {
  const root = path.resolve(unzipToDir);
  const normalizedEntryName = entryName.replace(/\//g, path.sep);
  const fullPath = path.resolve(root, normalizedEntryName);
  const relativePath = path.relative(root, fullPath);
  if (
    relativePath.startsWith('..') ||
    path.isAbsolute(relativePath) ||
    relativePath === ''
  ) {
    throw new UpdateError({
      message: `Unsafe zip entry path: ${entryName}`,
      phase: 'extract-release',
    });
  }
  return fullPath;
}

const unzip = (zipPath, unzipToDir): Effect.Effect<void, UpdaterError> =>
  Effect.async<void, UpdaterError>((resume) => {
    let zipFile: ZipFile | null = null;
    let activeFile: fs.WriteStream | null = null;
    let activeReadStream:
      | (NodeJS.ReadableStream & {
          destroy(): void;
        })
      | null = null;
    let filesProcessed = 0;
    let totalFiles = 0;
    let settled = false;
    logUpdater('Starting unzip', { zipPath, unzipToDir });

    const finish = (effect: Effect.Effect<void, UpdaterError>) => {
      if (settled) return;
      settled = true;
      activeFile?.destroy();
      activeReadStream?.destroy?.();
      zipFile?.close();
      resume(effect);
    };
    const fail = (cause: unknown) =>
      finish(
        Effect.fail(
          cause instanceof UpdateError
            ? cause
            : new UpdateError({
                message: formatCause(cause),
                phase: 'extract-release',
                cause,
              })
        )
      );
    const completeEntry = () => {
      filesProcessed++;
      sendUpdaterStatus('Extracting Update', filesProcessed, totalFiles);
      if (filesProcessed >= totalFiles) {
        logUpdater('Completed unzip', { zipPath, unzipToDir, totalFiles });
        finish(Effect.void);
      } else {
        zipFile?.readEntry();
      }
    };

    try {
      fs.mkdirSync(unzipToDir, { recursive: true });
      yauzl.open(zipPath, { lazyEntries: true }, (openError, zip) => {
        if (openError || !zip) {
          fail(openError ?? new Error('Unable to open zip archive'));
          return;
        }
        zipFile = zip;
        totalFiles = zip.entryCount;
        logUpdater('Opened zip archive', { zipPath, totalFiles });
        zip.on('entry', (entry) => {
          try {
            sendUpdaterStatus('Extracting Update', filesProcessed, totalFiles);
            const fullPath = resolveZipEntryPath(unzipToDir, entry.fileName);
            fs.mkdirSync(path.dirname(fullPath), { recursive: true });
            if (/\/$/.test(entry.fileName)) {
              completeEntry();
              return;
            }
            zip.openReadStream(entry, (readError, readStream) => {
              if (readError || !readStream) {
                fail(readError ?? new Error('Unable to read zip entry'));
                return;
              }
              activeReadStream = readStream;
              const file = fs.createWriteStream(fullPath);
              activeFile = file;
              readStream.pipe(file);
              file.once('finish', () =>
                file.close((closeError) => {
                  activeFile = null;
                  activeReadStream = null;
                  if (closeError) fail(closeError);
                  else completeEntry();
                })
              );
              file.once('error', fail);
              readStream.once('error', fail);
            });
          } catch (cause) {
            fail(cause);
          }
        });
        zip.once('end', () => finish(Effect.void));
        zip.once('error', fail);
        zip.readEntry();
      });
    } catch (cause) {
      fail(cause);
    }

    return Effect.sync(() => {
      activeFile?.destroy();
      activeReadStream?.destroy?.();
      zipFile?.close();
    });
  });

app.on('ready', () => {
  void runUpdater(createWindow()).catch((error) => {
    console.error('Updater workflow failed:', error);
    dialog.showErrorBox('OpenGameInstaller updater failed', error.message);
    app.exit(1);
  });
});
