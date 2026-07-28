import { createHash, randomUUID } from 'node:crypto';
import type { WriteStream } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import axios, { type AxiosResponse } from 'axios';
import { type ChildProcess, spawn, spawnSync } from 'child_process';
import { app, BrowserWindow, dialog, ipcMain, net } from 'electron';
import fs from 'fs';
import path, { join } from 'path';
import yauzl, { type ZipFile } from 'yauzl';
import pjson from '../package.json' with { type: 'json' };
import {
  decideUpdaterStartup,
  getRequestedOnlineState,
  resolveEffectiveOnlineState,
} from './offline-decision.js';
import {
  installPreparedProductionUpdate as coordinatePreparedProductionUpdate,
  type ProcessIdentity,
  recoverInterruptedProductionUpdate,
} from './production-update-coordinator.mjs';
import {
  type UpdaterStatusPayload,
  updaterFailure,
  updaterProgress,
  updaterStatus,
} from './status.js';
import {
  applyBlockmapPatch as applyVerifiedBlockmapPatch,
  resolveApplicationLauncher,
  stageTransactionalCandidate,
  stageVerifiedDownload,
  verifyReleaseArtifact as verifyVerifiedReleaseArtifact,
} from './update-engine.mjs';
import {
  parseWindowsJobLaunchEvidence,
  parseWindowsJobResultEvidence,
} from './windows-job-evidence.mjs';

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

const RANGE_DOWNLOAD_CONCURRENCY = 6;
const HTTP_RETRY_ATTEMPTS = 4;
const HTTP_RETRY_BASE_DELAY_MS = 1500;
const HTTP_REQUEST_TIMEOUT_MS = 60000;
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

function getRepoHeadSha(repoDir: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['rev-parse', 'HEAD'], { cwd: repoDir });
    let stdout = '';
    child.stdout?.on('data', (data) => {
      stdout += data.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error('git rev-parse HEAD failed'));
        return;
      }
      resolve(stdout.trim());
    });
  });
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

function getApplicationBuildCommand() {
  return process.platform === 'win32'
    ? ['bun', ['run', '--cwd', 'application', 'electron-pack']]
    : ['bun', ['run', '--cwd', 'application', 'electron-pack:linux']];
}

type CommandResult = { stdout: string; stderr: string };
type BleedingEdgeSyncResult = {
  beforePullSha: string;
  afterPullSha: string;
  pullOutput: string;
  pullWasNoop: boolean;
};

type RunCommandOptions = {
  cwd?: string;
  /** Skip UI status updates (e.g. git metadata for branch/commit picker). */
  quiet?: boolean;
};

function runCommand(
  command,
  args,
  options: RunCommandOptions = {}
): Promise<CommandResult> {
  const { quiet = false, ...spawnOptions } = options;
  return new Promise((resolve, reject) => {
    logUpdater(`Running command: ${command} ${args.join(' ')}`);
    const child = spawn(command, args, {
      ...spawnOptions,
      shell: process.platform === 'win32',
    });
    let stdout = '';
    let stderr = '';
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
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve({ stdout, stderr })
        : reject(new Error(`${command} exited with code ${code}`))
    );
  });
}

async function syncBleedingEdgeRepo(
  repoDir: string,
  branch: string
): Promise<BleedingEdgeSyncResult> {
  const targetBranch = branch || DEFAULT_BLEEDING_EDGE_BRANCH;
  await runCommand(
    'git',
    ['fetch', '--prune', '--tags', 'origin', ALL_ORIGIN_HEADS_REFSPEC],
    { cwd: repoDir }
  );
  await runCommand('git', ['checkout', targetBranch], { cwd: repoDir });
  const beforePullSha = await getRepoHeadSha(repoDir);
  const pullResult = await runCommand(
    'git',
    ['pull', '--ff-only', 'origin', targetBranch],
    { cwd: repoDir }
  );
  const afterPullSha = await getRepoHeadSha(repoDir);
  const pullOutput = `${pullResult.stdout}\n${pullResult.stderr}`;
  const pullWasNoop =
    /already up[ -]to[ -]date/i.test(pullOutput) &&
    beforePullSha === afterPullSha;
  return { beforePullSha, afterPullSha, pullOutput, pullWasNoop };
}

/** Match .github/workflows/build-release.yml after hoisted `bun install`. */
function syncHoistedElectronPackages(repoDir: string) {
  const rootElectron = path.join(repoDir, 'node_modules', 'electron');
  if (!fs.existsSync(rootElectron)) {
    throw new Error(
      'electron not found in repo root node_modules after install'
    );
  }
  for (const pkg of ['application', 'updater'] as const) {
    const dest = path.join(repoDir, pkg, 'node_modules', 'electron');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.rmSync(dest, { recursive: true, force: true });
    fs.cpSync(rootElectron, dest, { recursive: true });
  }
}

async function ensureBleedingEdgeBuild(
  commit = '',
  branch = DEFAULT_BLEEDING_EDGE_BRANCH
) {
  const repoDir = getBleedingEdgeRepoDir();
  const targetBranch = branch || DEFAULT_BLEEDING_EDGE_BRANCH;
  sendUpdaterStatus('Preparing Bleeding Edge');
  let syncResult: BleedingEdgeSyncResult | null = null;
  if (!fs.existsSync(path.join(repoDir, '.git'))) {
    fs.rmSync(repoDir, { recursive: true, force: true });
    await runCommand('git', [
      'clone',
      '--branch',
      targetBranch,
      OGI_REPO_URL,
      repoDir,
    ]);
  } else {
    syncResult = await syncBleedingEdgeRepo(repoDir, targetBranch);
  }
  if (commit) {
    await runCommand('git', ['checkout', commit], { cwd: repoDir });
  }

  const headSha = await getRepoHeadSha(repoDir);
  if (
    !commit &&
    syncResult?.pullWasNoop &&
    shouldSkipBranchOnlyBleedingEdgeBuild(targetBranch, headSha)
  ) {
    sendUpdaterStatus(
      'Bleeding Edge up to date',
      undefined,
      undefined,
      'Skipping build'
    );
    writeCommitEdgeFile(targetBranch, '', headSha);
    return;
  }

  await runCommand('bun', ['install', '--linker=hoisted'], { cwd: repoDir });
  syncHoistedElectronPackages(repoDir);
  await runCommand('bun', ['run', 'build'], { cwd: repoDir });
  const [buildCommand, buildArgs] = getApplicationBuildCommand();
  await runCommand(buildCommand, buildArgs, { cwd: repoDir });

  let candidatePath: string;
  if (process.platform === 'win32') {
    const exe = findFirstFile(
      path.join(repoDir, 'application', 'dist'),
      (name) =>
        name.toLowerCase().endsWith('.exe') &&
        !name.toLowerCase().includes('setup')
    );
    if (!exe) throw new Error('Built Windows executable not found');
    candidatePath = createSameFilesystemCandidatePath('directory');
    await stageTransactionalCandidate({
      workingPath: getProductionTransactionPaths().workingPath,
      candidatePath,
      build: () => {
        fs.mkdirSync(candidatePath, { recursive: true });
        fs.copyFileSync(exe, path.join(candidatePath, 'OpenGameInstaller.exe'));
      },
      validate: () => {
        resolveApplicationLauncher(candidatePath, 'win32');
      },
    });
  } else {
    const appImage = findFirstFile(
      path.join(repoDir, 'application', 'dist'),
      (name) => name.toLowerCase().endsWith('.appimage')
    );
    if (!appImage) throw new Error('Built Linux AppImage not found');
    candidatePath = await materializeLinuxCandidate(appImage);
  }
  return {
    candidatePath,
    assetName: path.basename(candidatePath),
    tagName: localVersion,
    commitMetadata: () =>
      writeCommitEdgeFile(targetBranch, commit, commit ? '' : headSha),
  } satisfies PreparedProductionUpdate;
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

async function getBranches(): Promise<string[]> {
  const repoDir = getBleedingEdgeRepoDir();
  if (fs.existsSync(path.join(repoDir, '.git'))) {
    try {
      await runCommand(
        'git',
        ['fetch', '--prune', 'origin', ALL_ORIGIN_HEADS_REFSPEC],
        {
          cwd: repoDir,
          quiet: true,
        }
      );
      const { stdout } = await runCommand(
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
        if (name && name !== 'HEAD') {
          datedBranches.push({ name, date });
        }
      }
      if (datedBranches.length) {
        const others = datedBranches
          .filter((branch) => branch.name !== 'main')
          .map((branch) => branch.name);
        return datedBranches.some((branch) => branch.name === 'main')
          ? ['main', ...others]
          : others;
      }
    } catch (error) {
      logUpdater('Local git branch listing failed, using ls-remote:', error);
    }
  }

  const { stdout } = await runCommand(
    'git',
    ['ls-remote', '--heads', OGI_REPO_URL],
    {
      quiet: true,
    }
  );
  const names = new Set<string>();
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const tab = trimmed.lastIndexOf('\t');
    if (tab === -1) continue;
    const name = parseRemoteBranchName(trimmed.slice(tab + 1));
    if (name) {
      names.add(name);
    }
  }
  const unique = [...names];
  const others = unique
    .filter((name) => name !== 'main')
    .sort((a, b) => a.localeCompare(b));
  return unique.includes('main') ? ['main', ...others] : others;
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

async function getRecentCommits(
  branch = DEFAULT_BLEEDING_EDGE_BRANCH
): Promise<RecentCommit[]> {
  const targetBranch = branch || DEFAULT_BLEEDING_EDGE_BRANCH;
  const logFormat = '%H%x1f%an%x1f%cI%x1f%s';
  const repoDir = getBleedingEdgeRepoDir();

  if (fs.existsSync(path.join(repoDir, '.git'))) {
    await runCommand(
      'git',
      [
        'fetch',
        'origin',
        `+refs/heads/${targetBranch}:refs/remotes/origin/${targetBranch}`,
        '--depth',
        '12',
      ],
      {
        cwd: repoDir,
        quiet: true,
      }
    );
    const { stdout } = await runCommand(
      'git',
      ['log', `origin/${targetBranch}`, '-12', `--format=${logFormat}`],
      { cwd: repoDir, quiet: true }
    );
    const commits = parseGitLogCommits(stdout);
    if (commits.length) {
      return commits;
    }
  }

  const tmpDir = path.join(
    app.getPath('temp'),
    `ogi-updater-commits-${process.pid}-${Date.now()}`
  );
  fs.rmSync(tmpDir, { recursive: true, force: true });
  try {
    await runCommand(
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
    const { stdout } = await runCommand(
      'git',
      ['log', 'HEAD', '-12', `--format=${logFormat}`],
      { cwd: tmpDir, quiet: true }
    );
    return parseGitLogCommits(stdout);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

ipcMain.handle('get-branches', async () => {
  try {
    const branches = await getBranches();
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
    const commits = await getRecentCommits(targetBranch);
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
  return resolveEffectiveOnlineState(requestedOnline, net.isOnline());
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
  title: string,
  progress?: number,
  max?: number,
  detail?: string
) {
  const payload =
    typeof progress === 'number' &&
    Number.isFinite(progress) &&
    typeof max === 'number' &&
    Number.isFinite(max) &&
    max > 0
      ? updaterProgress(title, progress, max, detail)
      : updaterStatus(title, detail);
  sendUpdaterStatusPayload(payload);
}

function sendUpdaterFailure(title: string, detail?: string) {
  sendUpdaterStatusPayload(updaterFailure(title, detail));
}

function sendUpdaterStatusPayload(payload: UpdaterStatusPayload) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.webContents.send('updater-status', payload);
}

function nextUiTick() {
  return new Promise((resolve) => setImmediate(resolve));
}

function logUpdater(message: string, ...args: unknown[]) {
  console.log(`[updater] ${message}`, ...args);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
async function createWindow() {
  const interruptedRecovery = await recoverInterruptedProductionTransaction();
  if (interruptedRecovery.recoveryHealth?.processAlive === true) {
    launchedApplication?.unref();
    app.exit(0);
    return;
  }
  const startupDecision = decideUpdaterStartup(process.argv, net.isOnline());
  if (startupDecision.action === 'check-for-updates') {
    // Check whether the application SDK port is already serving only when online.
    try {
      const port_check = await fetch('http://localhost:7654');
      if (port_check.ok) {
        console.error(
          'Port 7654 is already in use, meaning OpenGameInstaller is already running. Exiting.'
        );
        dialog.showErrorBox(
          'OpenGameInstaller is already running',
          'OpenGameInstaller is already running. Please close the other instance before launching OpenGameInstaller again.'
        );
        app.exit(1);
      }
    } catch {
      console.log("Port isn't in use! Launching....");
    }
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
  await mainWindow.loadURL(`file://${app.getAppPath()}/public/index.html`);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  // disable opening devtools
  mainWindow.webContents.on('devtools-opened', () => {
    mainWindow.webContents.closeDevTools();
  });

  const initialOnlineState = startupDecision.onlineState;
  if (startupDecision.action === 'skip-update-and-launch-offline') {
    console.log(
      initialOnlineState.reason === 'cli-offline'
        ? 'Updater requested offline mode, skipping update check'
        : 'Device is offline, skipping update check'
    );
    sendUpdaterStatus(
      'Launching OpenGameInstaller',
      undefined,
      undefined,
      'Offline Mode'
    );
    launchApp(false);
    return;
  }

  if (hasArg('--gui')) {
    mainWindow.webContents.send('show-channel-picker');
    const choice: any = await new Promise((resolve) => {
      ipcMain.once('choose-channel', (_event, payload) => resolve(payload));
    });
    const channel = choice?.channel || 'stable';
    if (channel === 'stable') {
      fs.rmSync('./bleeding-edge.txt', { force: true });
      fs.rmSync('./COMMIT_EDGE.txt', { force: true });
      usingBleedingEdge = false;
    } else if (channel === 'unstable') {
      fs.writeFileSync('./bleeding-edge.txt', 'true');
      fs.rmSync('./COMMIT_EDGE.txt', { force: true });
      usingBleedingEdge = true;
    } else if (channel === 'bleeding-edge') {
      try {
        const prepared = await ensureBleedingEdgeBuild(
          (choice?.commit || '').trim(),
          (choice?.branch || DEFAULT_BLEEDING_EDGE_BRANCH).trim()
        );
        sendUpdaterStatus('Launching OpenGameInstaller');
        await activatePreparedUpdateOrLaunchExisting(prepared);
        return;
      } catch (err) {
        console.error(err);
        sendUpdaterFailure('Bleeding Edge Failed', err.message);
        launchApp(true);
        return;
      }
    }
  } else if (updateChannel === 'bleeding-edge') {
    try {
      const { branch, commit } = getCommitEdgeTarget();
      const prepared = await ensureBleedingEdgeBuild(commit, branch);
      sendUpdaterStatus('Launching OpenGameInstaller');
      await activatePreparedUpdateOrLaunchExisting(prepared);
      return;
    } catch (err) {
      console.error(err);
      sendUpdaterFailure('Bleeding Edge Failed', err.message);
      launchApp(true);
      return;
    }
  }

  // check for updates
  const gitRepo = 'Nat3z/OpenGameInstaller';

  // check the github releases
  try {
    const response = await axios.get(
      `https://api.github.com/repos/${gitRepo}/releases`,
      { timeout: 10000 } // 10 second timeout for update check
    );
    sendUpdaterStatus('Checking for Updates');
    const releases = response.data
      .filter((rel) => usingBleedingEdge || !rel.prerelease)
      .sort(compareReleaseOrder);
    const localIndex = releases.findIndex(
      (rel) => rel.tag_name === localVersion
    );
    const targetRelease = releases[0];
    let updating = Boolean(targetRelease) && localIndex !== 0;
    if (targetRelease && updating) {
      const releasePath =
        localIndex > 0
          ? releases.slice(0, localIndex).reverse()
          : [targetRelease];
      const gap =
        localIndex > 0 ? releasePath.length : Number.POSITIVE_INFINITY;
      let preparedUpdate: PreparedProductionUpdate | null = null;

      if (Number.isFinite(gap) && gap > 0 && gap <= 3) {
        sendUpdaterStatus('Preparing incremental update path');
        try {
          preparedUpdate = await applyBlockmapPath(releasePath, releases);
        } catch (patchErr) {
          console.error('Incremental patching failed, falling back:', patchErr);
          sendUpdaterStatus(
            'Falling back to full download',
            undefined,
            undefined,
            patchErr.message
          );
        }
      } else if (!Number.isFinite(gap)) {
        sendUpdaterStatus(
          'Falling back to full download',
          undefined,
          undefined,
          'Local version missing from release feed'
        );
      } else {
        sendUpdaterStatus(
          'Falling back to full download',
          undefined,
          undefined,
          'Version too old for incremental update'
        );
      }

      if (!preparedUpdate) {
        preparedUpdate = await downloadFullRelease(targetRelease);
      }
      try {
        productionTransactionAttempted = true;
        await installPreparedProductionUpdate(preparedUpdate);
        sendUpdaterStatus(
          'Startup Health Confirmed',
          undefined,
          undefined,
          'The candidate is interactive and the update was committed'
        );
        launchedApplication?.unref();
        app.exit(0);
      } catch (updateError) {
        const detail =
          updateError instanceof Error
            ? updateError.message
            : String(updateError);
        console.error('Transactional update failed:', updateError);
        if (updateError?.recoveryCompleted) {
          sendUpdaterFailure(
            'Previous Installation Restored',
            `The update failed, but the Last Known-Good Installation is healthy. ${detail}`
          );
          launchedApplication?.unref();
          app.exit(1);
          return;
        }
        sendUpdaterFailure('Update Recovery Failed', detail);
        throw updateError;
      }
      return;
    }
    if (!updating) {
      sendUpdaterStatus(
        'Launching OpenGameInstaller',
        undefined,
        undefined,
        'No Updates Found'
      );
      launchApp(true);
    }
  } catch (e) {
    console.error(e);
    if (productionTransactionAttempted) {
      sendUpdaterFailure(
        'Update Requires Attention',
        e instanceof Error ? e.message : String(e)
      );
      return;
    }
    const onlineState = getEffectiveOnlineState();
    if (!onlineState.effectiveOnline) {
      sendUpdaterStatus(
        'Launching OpenGameInstaller',
        undefined,
        undefined,
        'Offline Mode'
      );
      launchApp(false);
      return;
    }
    sendUpdaterFailure(
      'Launching OpenGameInstaller',
      'Failed to check for updates'
    );
    launchApp(true);
  }
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

async function ensureCachedSourceArtifact(cacheDir, release, asset) {
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

  await downloadToFile(
    asset.browser_download_url,
    sourceArtifactPath,
    `Downloading base artifact ${release.tag_name}`
  );
  return sourceArtifactPath;
}

async function ensureCachedBlockmap(
  cacheDir: string,
  release: any,
  asset: any
) {
  const blockmapAsset = getBlockmapAsset(release, asset);
  if (!blockmapAsset) {
    throw new Error(`Blockmap missing for ${release.tag_name}`);
  }

  const blockmapPath = path.join(cacheDir, `${asset.name}.blockmap`);
  if (fs.existsSync(blockmapPath)) {
    return blockmapPath;
  }

  fs.mkdirSync(cacheDir, { recursive: true });
  await downloadToFile(
    blockmapAsset.browser_download_url,
    blockmapPath,
    `Downloading blockmap ${release.tag_name}`
  );
  return blockmapPath;
}

async function downloadToFile(
  url: string,
  destination: string,
  status: string
) {
  logUpdater(`Starting download: ${status}`, { url, destination });
  for (let attempt = 1; attempt <= HTTP_RETRY_ATTEMPTS; attempt++) {
    let writer: WriteStream | undefined;
    let response: AxiosResponse | undefined;
    try {
      fs.rmSync(destination, { force: true });
      writer = fs.createWriteStream(destination);
      response = await axios({
        url,
        method: 'GET',
        responseType: 'stream',
        timeout: HTTP_REQUEST_TIMEOUT_MS,
        ...getAxiosTransportOptions(url),
      });
      response.data.pipe(writer);
      const startTime = Date.now();
      const contentLength = response.headers['content-length'];
      const fileSize =
        contentLength === undefined
          ? undefined
          : Number(
              Array.isArray(contentLength) ? contentLength[0] : contentLength
            );
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
      await new Promise<void>((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
        response.data.on('error', reject);
      });
      logUpdater(`Finished download: ${status}`, {
        destination,
        bytesWritten: writer.bytesWritten,
        attempt,
      });
      return;
    } catch (error) {
      writer?.destroy();
      response?.data?.destroy?.();
      fs.rmSync(destination, { force: true });

      const retryable = shouldRetryHttpError(error);
      logUpdater(`Download attempt failed: ${status}`, {
        destination,
        attempt,
        retryable,
        error: error?.message,
        code: error?.code,
        statusCode: error?.response?.status,
      });
      if (!retryable || attempt === HTTP_RETRY_ATTEMPTS) {
        throw error;
      }
      const delayMs = getRetryDelay(attempt);
      sendUpdaterStatus(
        status,
        undefined,
        undefined,
        `Retrying (${attempt + 1}/${HTTP_RETRY_ATTEMPTS})`
      );
      await sleep(delayMs);
    }
  }
}

type PreparedProductionUpdate = {
  candidatePath: string;
  assetName: string;
  tagName: string;
  commitMetadata?: () => void;
};

let launchedApplication: ChildProcess | null = null;
let productionTransactionAttempted = false;

function getProductionTransactionPaths() {
  const stateRoot = path.resolve(__dirname, 'update-state');
  const workingPath =
    process.platform === 'win32'
      ? path.resolve(__dirname, 'update')
      : path.resolve(__dirname, 'update', 'OpenGameInstaller.AppImage');
  const backupPath =
    process.platform === 'win32'
      ? path.join(stateRoot, 'last-known-good-installation')
      : path.join(stateRoot, 'last-known-good.AppImage');
  const retiredBackupPath =
    process.platform === 'win32'
      ? path.join(stateRoot, 'retired-last-known-good-installation')
      : path.join(stateRoot, 'retired-last-known-good.AppImage');
  const journalPath = path.join(stateRoot, 'transaction.json');
  const metadataPath = path.resolve('./version.txt');
  return {
    stateRoot,
    workingPath,
    backupPath,
    retiredBackupPath,
    journalPath,
    metadataPath,
  };
}

function createSameFilesystemCandidatePath(kind: 'file' | 'directory') {
  const { stateRoot } = getProductionTransactionPaths();
  const candidatesRoot = path.join(stateRoot, 'candidates');
  fs.mkdirSync(candidatesRoot, { recursive: true });
  return path.join(
    candidatesRoot,
    `${Date.now()}-${randomUUID()}.${kind === 'file' ? 'AppImage' : 'installation'}`
  );
}

async function materializeLinuxCandidate(sourceArtifact: string) {
  const candidatePath = createSameFilesystemCandidatePath('file');
  return stageTransactionalCandidate({
    workingPath: getProductionTransactionPaths().workingPath,
    candidatePath,
    build: () => {
      fs.copyFileSync(sourceArtifact, candidatePath);
      fs.chmodSync(candidatePath, '755');
    },
    validate: () => {
      if (fs.statSync(candidatePath).size <= 0) {
        throw new Error('Linux candidate materialization failed');
      }
    },
  });
}

async function materializeWindowsCandidate(
  cacheDir: string,
  sourceArtifact: string
) {
  const candidatePath = createSameFilesystemCandidatePath('directory');
  return stageTransactionalCandidate({
    workingPath: getProductionTransactionPaths().workingPath,
    candidatePath,
    build: () => {
      fs.mkdirSync(candidatePath, { recursive: true });
      for (const file of fs.readdirSync(cacheDir)) {
        const lowerName = file.toLowerCase();
        if (lowerName.endsWith('.blockmap') || lowerName.endsWith('.zip'))
          continue;
        fs.cpSync(path.join(cacheDir, file), path.join(candidatePath, file), {
          recursive: true,
          force: false,
          errorOnExist: true,
        });
      }
      const artifactPath = path.join(
        candidatePath,
        'artifacts',
        path.basename(sourceArtifact)
      );
      fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
      fs.copyFileSync(sourceArtifact, artifactPath);
    },
    validate: () => {
      resolveApplicationLauncher(candidatePath, 'win32');
    },
  });
}

async function materializeProductionCandidate(
  cacheDir: string,
  sourceArtifact: string
) {
  return process.platform === 'win32'
    ? materializeWindowsCandidate(cacheDir, sourceArtifact)
    : materializeLinuxCandidate(sourceArtifact);
}

function applicationIsAlive(child: ChildProcess | null) {
  return Boolean(
    child && child.exitCode === null && child.signalCode === null && child.pid
  );
}

async function waitForApplicationExit(child: ChildProcess, timeoutMs: number) {
  if (!applicationIsAlive(child)) return true;
  await Promise.race([
    new Promise((resolvePromise) => child.once('exit', resolvePromise)),
    sleep(timeoutMs),
  ]);
  return !applicationIsAlive(child);
}

function processIdIsAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

function processIdentitiesMatch(
  expected: ProcessIdentity,
  actual: ProcessIdentity
) {
  return (
    expected.pid === actual.pid &&
    expected.startTime === actual.startTime &&
    path.resolve(expected.executable) === path.resolve(actual.executable) &&
    expected.transactionToken === actual.transactionToken
  );
}

function readLinuxProcessProofToken(pid: number) {
  for (const descriptor of fs.readdirSync(`/proc/${pid}/fd`)) {
    try {
      const descriptorPath = `/proc/${pid}/fd/${descriptor}`;
      if (!fs.readlinkSync(descriptorPath).includes('.ogi-process-proof-')) {
        continue;
      }
      const token = fs.readFileSync(descriptorPath, 'utf8');
      if (/^[0-9a-f-]{36}$/i.test(token)) return token;
    } catch {}
  }
  return undefined;
}

async function readProductionProcessIdentity(
  pid: number
): Promise<ProcessIdentity | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0 || !processIdIsAlive(pid)) {
    return null;
  }
  if (process.platform !== 'win32') {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const closeParen = stat.lastIndexOf(')');
      const fields = stat.slice(closeParen + 2).split(' ');
      const startTime = fields[19];
      const executable = fs.readlinkSync(`/proc/${pid}/exe`);
      const environment = fs
        .readFileSync(`/proc/${pid}/environ`)
        .toString('utf8')
        .split('\0');
      const tokenVariable = environment.find((variable) =>
        variable.startsWith('OGI_UPDATE_TRANSACTION_TOKEN=')
      );
      const proofToken = readLinuxProcessProofToken(pid);
      const transactionToken =
        tokenVariable?.slice('OGI_UPDATE_TRANSACTION_TOKEN='.length) ??
        proofToken;
      if (!startTime || !transactionToken) return null;
      return {
        pid,
        startTime,
        executable,
        transactionToken,
        proofBound: proofToken === transactionToken,
      };
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ESRCH') return null;
      throw error;
    }
  }

  const script = `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; if ($null -eq $p) { exit 3 }; [Console]::Out.Write(($p | Select-Object ProcessId,@{Name='CreationTime';Expression={$_.CreationDate.ToUniversalTime().ToFileTimeUtc()}},ExecutablePath,CommandLine | ConvertTo-Json -Compress))`;
  const output = await new Promise<string>((resolvePromise, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-Command', script], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 3) resolvePromise('');
      else if (code === 0) resolvePromise(stdout);
      else
        reject(new Error(`Windows process identity query failed: ${stderr}`));
    });
  });
  if (!output) return null;
  const value = JSON.parse(output);
  const commandLine = String(value.CommandLine ?? '');
  const token = commandLine.match(
    /--ogi-update-transaction-token=([^\s"']+)/
  )?.[1];
  const wrapperToken = commandLine.match(
    /(?:^|\s)-WrapperToken\s+["']?([^\s"']+)/i
  )?.[1];
  if (!value.CreationTime || !value.ExecutablePath || !token) return null;
  return {
    pid,
    startTime: String(value.CreationTime),
    executable: String(value.ExecutablePath),
    transactionToken: token,
    processRole: wrapperToken ? 'windows-job-wrapper' : 'application',
    ...(wrapperToken ? { windowsJobWrapperToken: wrapperToken } : {}),
  };
}

async function discoverProductionProcesses(launchIntent: {
  executable: string;
  transactionToken: string;
  allowProofBoundExecTransition?: boolean;
  windowsJob?: {
    wrapperExecutable: string;
    wrapperToken: string;
    resultPath: string;
    stopPath: string;
  };
}) {
  let pids: number[] = [];
  if (process.platform === 'linux') {
    pids = fs
      .readdirSync('/proc')
      .filter((entry) => /^\d+$/.test(entry))
      .map(Number);
  } else if (process.platform === 'win32') {
    const escapedToken = launchIntent.transactionToken.replace(/'/g, "''");
    const script = `$p = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*--ogi-update-transaction-token=${escapedToken}*' }; [Console]::Out.Write(($p.ProcessId | ConvertTo-Json -Compress))`;
    const discoveredPids = new Set<number>();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const output = spawnSync(
        'powershell.exe',
        ['-NoProfile', '-Command', script],
        { windowsHide: true, encoding: 'utf8' }
      );
      if (output.status !== 0) {
        throw new Error(
          `Windows owned-process discovery failed: ${output.stderr}`
        );
      }
      const parsed = output.stdout ? JSON.parse(output.stdout) : [];
      for (const pid of (Array.isArray(parsed) ? parsed : [parsed])
        .map(Number)
        .filter(Number.isSafeInteger)) {
        discoveredPids.add(pid);
      }
      if (attempt < 2) await sleep(25);
    }
    pids = [...discoveredPids];
  }
  const identities = (
    await Promise.all(pids.map((pid) => readProductionProcessIdentity(pid)))
  ).filter((identity): identity is ProcessIdentity => identity !== null);
  return identities
    .filter((identity) => {
      if (identity.transactionToken !== launchIntent.transactionToken) {
        return false;
      }
      if (launchIntent.windowsJob) {
        return (
          (identity.processRole === 'windows-job-wrapper' &&
            path.resolve(identity.executable) ===
              path.resolve(launchIntent.windowsJob.wrapperExecutable) &&
            identity.windowsJobWrapperToken ===
              launchIntent.windowsJob.wrapperToken) ||
          (identity.processRole === 'application' &&
            path.resolve(identity.executable) ===
              path.resolve(launchIntent.executable))
        );
      }
      return (
        path.resolve(identity.executable) ===
          path.resolve(launchIntent.executable) ||
        (launchIntent.allowProofBoundExecTransition === true &&
          identity.proofBound === true)
      );
    })
    .map((identity) =>
      launchIntent.windowsJob
        ? {
            ...identity,
            windowsJobStopPath: launchIntent.windowsJob.stopPath,
            windowsJobResultPath: launchIntent.windowsJob.resultPath,
          }
        : identity
    );
}

function resolveProductionLaunchExecutable({
  workingPath,
}: {
  workingPath: string;
  transactionToken?: string;
}) {
  const executable = resolveApplicationLauncher(
    process.platform === 'win32' ? workingPath : path.dirname(workingPath),
    process.platform === 'win32' ? 'win32' : 'linux'
  );
  const resolved = {
    executable,
    launcherDigest: createHash('sha256')
      .update(fs.readFileSync(executable))
      .digest('hex'),
    allowProofBoundExecTransition: process.platform === 'linux',
  };
  if (process.platform !== 'win32') return resolved;
  const controlToken = randomUUID();
  const { stateRoot } = getProductionTransactionPaths();
  return {
    ...resolved,
    windowsJob: {
      wrapperExecutable: path.join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe'
      ),
      wrapperScript: path.join(__dirname, 'windows-job-wrapper.ps1'),
      wrapperToken: randomUUID(),
      launchPath: path.join(
        stateRoot,
        `windows-job-launch-${controlToken}.json`
      ),
      resultPath: path.join(
        stateRoot,
        `windows-job-result-${controlToken}.json`
      ),
      stopPath: path.join(
        stateRoot,
        `windows-job-stop-${controlToken}.request`
      ),
    },
  };
}

async function productionProcessIsAlive(identity: ProcessIdentity) {
  const actual = await readProductionProcessIdentity(identity.pid);
  return Boolean(actual && processIdentitiesMatch(identity, actual));
}

const LINUX_PIDFD_TERMINATOR = `
import os, select, signal, sys, time
root = int(sys.argv[1])
expected_start, expected_exe, expected_token = sys.argv[2:5]
def token_claimed(pid):
    try:
        environment = open(f'/proc/{pid}/environ', 'rb').read().split(b'\\0')
        command = open(f'/proc/{pid}/cmdline', 'rb').read().split(b'\\0')
    except (FileNotFoundError, ProcessLookupError): return False
    except OSError: return False
    token = expected_token.encode()
    return b'OGI_UPDATE_TRANSACTION_TOKEN=' + token in environment or b'--ogi-update-transaction-token=' + token in command
def proof_bound(pid):
    try: descriptors = os.listdir(f'/proc/{pid}/fd')
    except FileNotFoundError: return False
    except OSError as error:
        if token_claimed(pid): raise RuntimeError(f'uninspectable proof-bearing process {pid}: {error}')
        return False
    for descriptor in descriptors:
        descriptor_path = f'/proc/{pid}/fd/{descriptor}'
        try: target = os.readlink(descriptor_path)
        except FileNotFoundError: continue
        except OSError as error:
            if token_claimed(pid): raise RuntimeError(f'uninspectable proof-bearing descriptor {pid}/{descriptor}: {error}')
            continue
        if '.ogi-process-proof-' not in target: continue
        try:
            with open(descriptor_path, encoding='utf-8') as proof: value = proof.read()
        except FileNotFoundError: continue
        except (OSError, UnicodeError) as error:
            if token_claimed(pid): raise RuntimeError(f'malformed proof descriptor {pid}/{descriptor}: {error}')
            continue
        if value == expected_token: return True
    return False
excluded_pids = set()
def scan():
    found = []
    for entry in os.listdir('/proc'):
        if entry.isdigit() and int(entry) not in excluded_pids and proof_bound(int(entry)): found.append(int(entry))
    return found
root_exists = os.path.exists(f'/proc/{root}')
if root_exists:
    try:
        stat = open(f'/proc/{root}/stat', encoding='utf-8').read()
        fields = stat[stat.rfind(')') + 2:].split(' ')
        actual_exe = os.readlink(f'/proc/{root}/exe')
    except (FileNotFoundError, ProcessLookupError): root_exists = False
    if root_exists and (fields[19] != expected_start or os.path.realpath(actual_exe) != os.path.realpath(expected_exe) or not proof_bound(root)):
        print('identity mismatch before pidfd tree termination; continuing root-independent proof scan', file=sys.stderr)
        excluded_pids.add(root)
        root_exists = False
try:
    if not hasattr(os, 'pidfd_open') or not hasattr(signal, 'pidfd_send_signal'): raise RuntimeError('pidfd APIs unavailable')
    deadline = time.monotonic() + 10
    all_pids, stable_zero = set(), 0
    while time.monotonic() < deadline:
        handles, frozen_pids, stable_discovery = {}, set(), 0
        try:
            while time.monotonic() < deadline and stable_discovery < 3:
                discovered = set(scan())
                new_pids = discovered - frozen_pids
                if not new_pids:
                    stable_discovery += 1
                    time.sleep(0.02)
                    continue
                stable_discovery = 0
                for pid in sorted(new_pids):
                    try:
                        handle = os.pidfd_open(pid, 0)
                        signal.pidfd_send_signal(handle, signal.SIGSTOP)
                        handles[pid] = handle
                        frozen_pids.add(pid)
                        all_pids.add(pid)
                    except ProcessLookupError: pass
            if not handles:
                stable_zero += 1
                if stable_zero >= 3:
                    print(','.join(str(pid) for pid in sorted(all_pids)), flush=True)
                    sys.exit(3 if not all_pids and not root_exists else 0)
                time.sleep(0.05)
                continue
            stable_zero = 0
            for handle in reversed(list(handles.values())):
                try: signal.pidfd_send_signal(handle, signal.SIGTERM)
                except ProcessLookupError: pass
            poller = select.poll()
            for handle in handles.values(): poller.register(handle, select.POLLIN)
            terminated_handles = {handle for handle, _ in poller.poll(500)}
            for handle in handles.values():
                if handle not in terminated_handles:
                    try: signal.pidfd_send_signal(handle, signal.SIGKILL)
                    except ProcessLookupError: pass
            poller.poll(1000)
        finally:
            for handle in handles.values(): os.close(handle)
    raise RuntimeError('proof-bound process tree did not reach stable zero')
except (AttributeError, OSError, RuntimeError) as error:
    print(f'pidfd tree termination failed: {error}', file=sys.stderr); sys.exit(5)
`;

const WINDOWS_PROCESS_HANDLE_TERMINATOR = `
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
public static class OgiOwnedProcess {
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr process, int flags, StringBuilder name, ref int size);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool MoveFileEx(string existing, string replacement, int flags);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static void ValidateRequestAndWait(int pid, long expectedCreation, string expectedExe, string requestPath) {
    IntPtr handle = OpenProcess(0x1000 | 0x0001 | 0x00100000, false, pid);
    if (handle == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    try {
      long creation, exit, kernel, user;
      if (!GetProcessTimes(handle, out creation, out exit, out kernel, out user)) throw new Win32Exception(Marshal.GetLastWin32Error());
      var executable = new StringBuilder(32768); int length = executable.Capacity;
      if (!QueryFullProcessImageName(handle, 0, executable, ref length)) throw new Win32Exception(Marshal.GetLastWin32Error());
      if (creation != expectedCreation || !String.Equals(executable.ToString(), expectedExe, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("identity mismatch after process handle open");
      string temporary = requestPath + ".tmp";
      using (var stream = new FileStream(temporary, FileMode.Create, FileAccess.Write, FileShare.None)) { stream.WriteByte(1); stream.Flush(true); }
      if (!MoveFileEx(temporary, requestPath, 0x1 | 0x8)) throw new Win32Exception(Marshal.GetLastWin32Error());
      if (WaitForSingleObject(handle, 20000) != 0) throw new InvalidOperationException("Job wrapper did not finish verified tree shutdown");
    } finally { CloseHandle(handle); }
  }
}`;

async function terminateProductionProcessHandle(identity: ProcessIdentity) {
  if (process.platform === 'linux') {
    const result = await new Promise<{
      code: number | null;
      stderr: string;
    }>((resolvePromise, reject) => {
      const helper = spawn(
        'python3',
        [
          '-c',
          LINUX_PIDFD_TERMINATOR,
          String(identity.pid),
          identity.startTime,
          identity.executable,
          identity.transactionToken,
        ],
        { stdio: ['ignore', 'ignore', 'pipe'] }
      );
      let stderr = '';
      helper.stderr?.on('data', (chunk) => {
        stderr += String(chunk);
      });
      helper.once('error', reject);
      helper.once('exit', (code) => resolvePromise({ code, stderr }));
    });
    if (result.code === 0 || result.code === 3) {
      return {
        processStopped: true,
        processExited: result.code === 3,
        processTreeStopped: true,
      };
    }
    throw new Error(
      `Linux pidfd identity-handle termination failed: ${result.stderr || `exit ${result.code}`}`
    );
  }
  if (process.platform !== 'win32') {
    throw new Error(
      'OS identity-handle process termination is unsupported on this platform'
    );
  }
  if (!identity.windowsJobStopPath || !identity.windowsJobResultPath) {
    throw new Error(
      'Windows Job Object shutdown evidence paths are unavailable'
    );
  }
  const escapedToken = identity.transactionToken.replace(/'/g, "''");
  const escapedExe = identity.executable.replace(/'/g, "''");
  const escapedStopPath = identity.windowsJobStopPath.replace(/'/g, "''");
  const script = `Add-Type -TypeDefinition @'\n${WINDOWS_PROCESS_HANDLE_TERMINATOR}\n'@; $p = Get-CimInstance Win32_Process -Filter "ProcessId = ${identity.pid}"; if ($null -eq $p) { exit 3 }; if ($p.CommandLine -notlike '*--ogi-update-transaction-token=${escapedToken}*') { throw 'transaction token mismatch' }; [OgiOwnedProcess]::ValidateRequestAndWait(${identity.pid}, [long]'${identity.startTime}', '${escapedExe}', '${escapedStopPath}')`;
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, encoding: 'utf8' }
  );
  if (result.status === 0 || result.status === 3) {
    const evidenceDeadline = Date.now() + 20_000;
    while (
      !fs.existsSync(identity.windowsJobResultPath) &&
      Date.now() < evidenceDeadline
    ) {
      await sleep(25);
    }
    if (!fs.existsSync(identity.windowsJobResultPath)) {
      throw new Error('Windows Job Object post-close evidence is missing');
    }
    const jobResult = parseWindowsJobResultEvidence(
      fs.readFileSync(identity.windowsJobResultPath, 'utf8')
    );
    if (jobResult.version !== 1 || jobResult.survivingPids.length !== 0) {
      throw new Error('Windows Job Object process tree stop was not verified');
    }
    return {
      processStopped: true,
      processExited: result.status === 3,
      processTreeStopped: true,
    };
  }
  throw new Error(
    `Windows process-handle termination failed: ${result.stderr || result.error?.message || `exit ${result.status}`}`
  );
}

async function launchAndWaitForProductionHealth({
  recovery,
  workingPath,
  transactionToken,
  launchIntent,
  onProcessStarted,
}) {
  const token = randomUUID();
  const { stateRoot } = getProductionTransactionPaths();
  const healthPath = path.join(stateRoot, `startup-health-${token}.json`);
  const healthRequestPath = `${healthPath}.request.json`;
  fs.mkdirSync(stateRoot, { recursive: true });
  fs.rmSync(healthPath, { force: true });
  fs.rmSync(healthRequestPath, { force: true });
  const installationDirectory =
    process.platform === 'win32' ? workingPath : path.dirname(workingPath);
  const launcher = resolveApplicationLauncher(
    installationDirectory,
    process.platform === 'win32' ? 'win32' : 'linux'
  );
  const logPath = path.join(
    stateRoot,
    recovery ? 'recovery.log' : 'candidate.log'
  );
  const logStream = fs.openSync(logPath, 'a');
  const effectiveOnline = getEffectiveOnlineState(true).effectiveOnline;
  const processProofPath = path.join(
    stateRoot,
    `.ogi-process-proof-${transactionToken}`
  );
  let processProofDescriptor: number | undefined;
  if (process.platform === 'linux') {
    fs.rmSync(processProofPath, { force: true });
    processProofDescriptor = fs.openSync(processProofPath, 'wx+', 0o600);
    fs.writeFileSync(processProofDescriptor, transactionToken);
    fs.fsyncSync(processProofDescriptor);
  }
  const args = [
    `--online=${effectiveOnline}`,
    `--ogi-update-transaction-token=${transactionToken}`,
    ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
  ];
  sendUpdaterStatus(
    recovery ? 'Verifying Previous Installation' : 'Verifying Startup Health',
    undefined,
    undefined,
    recovery
      ? 'Launching the restored Last Known-Good Installation'
      : 'Launching the candidate and waiting for interactive readiness'
  );
  const windowsJob = launchIntent?.windowsJob;
  if (process.platform === 'win32' && !windowsJob) {
    throw new Error(
      'Durable Windows Job Object launch controls are unavailable before spawn'
    );
  }
  const windowsJobLaunchPath = windowsJob?.launchPath ?? '';
  const windowsJobResultPath = windowsJob?.resultPath ?? '';
  const windowsJobStopPath = windowsJob?.stopPath ?? '';
  for (const controlPath of [
    windowsJobLaunchPath,
    windowsJobResultPath,
    windowsJobStopPath,
  ]) {
    if (controlPath) fs.rmSync(controlPath, { force: true });
  }
  const launchEnvironment = {
    ...process.env,
    OGI_STARTUP_HEALTH_PATH: healthPath,
    OGI_STARTUP_HEALTH_TOKEN: token,
    OGI_UPDATE_TRANSACTION_TOKEN: transactionToken,
    ...(process.platform === 'win32'
      ? {
          OGI_WINDOWS_JOB_LAUNCH: windowsJobLaunchPath,
          OGI_WINDOWS_JOB_RESULT: windowsJobResultPath,
          OGI_WINDOWS_JOB_STOP: windowsJobStopPath,
        }
      : {}),
  };
  fs.writeFileSync(
    healthRequestPath,
    JSON.stringify({
      version: 1,
      healthPath,
      token,
      transactionToken,
    }),
    { flag: 'wx', mode: 0o600 }
  );
  try {
    try {
      launchedApplication =
        process.platform === 'win32'
          ? spawn(
              windowsJob.wrapperExecutable,
              [
                '-NoProfile',
                '-NonInteractive',
                '-File',
                windowsJob.wrapperScript,
                '-WrapperToken',
                windowsJob.wrapperToken,
                launcher,
                ...args,
              ],
              {
                cwd: installationDirectory,
                detached: true,
                stdio: ['ignore', logStream, logStream],
                env: launchEnvironment,
                windowsHide: true,
              }
            )
          : spawn(launcher, args, {
              cwd: installationDirectory,
              detached: true,
              stdio: ['ignore', logStream, logStream, processProofDescriptor],
              env: launchEnvironment,
            });
    } finally {
      if (processProofDescriptor !== undefined) {
        fs.closeSync(processProofDescriptor);
        fs.rmSync(processProofPath, { force: true });
      }
    }
    await new Promise<void>((resolvePromise, reject) => {
      launchedApplication?.once('spawn', resolvePromise);
      launchedApplication?.once('error', reject);
    });
    const child = launchedApplication;
    if (!child?.pid)
      throw new Error('Application launch produced no process ID');
    let processIdentity = await readProductionProcessIdentity(child.pid);
    if (!processIdentity) {
      throw new Error(
        'Unable to establish non-reusable application process identity'
      );
    }
    let applicationPid = child.pid;
    if (process.platform === 'win32') {
      const jobDeadline = Date.now() + 10_000;
      while (!fs.existsSync(windowsJobLaunchPath) && Date.now() < jobDeadline) {
        if (!applicationIsAlive(child)) break;
        await sleep(25);
      }
      if (!fs.existsSync(windowsJobLaunchPath)) {
        throw new Error('Windows Job Object launch handshake failed');
      }
      const jobLaunch = parseWindowsJobLaunchEvidence(
        fs.readFileSync(windowsJobLaunchPath, 'utf8')
      );
      applicationPid = jobLaunch.rootPid;
      processIdentity = {
        ...processIdentity,
        applicationPid,
        windowsJobStopPath,
        windowsJobResultPath,
      };
    }
    onProcessStarted(processIdentity);
    const timeoutMs = Number.parseInt(
      process.env.OGI_STARTUP_HEALTH_TIMEOUT_MS ?? '45000',
      10
    );
    const deadline =
      Date.now() + (Number.isFinite(timeoutMs) ? timeoutMs : 45000);
    try {
      while (Date.now() < deadline) {
        if (!applicationIsAlive(child)) {
          throw new Error(
            `Application exited before Startup Health with status ${child?.exitCode} and signal ${child?.signalCode}`
          );
        }
        if (fs.existsSync(healthPath)) {
          const health = JSON.parse(fs.readFileSync(healthPath, 'utf8'));
          if (
            health.version !== 1 ||
            health.state !== 'interactive' ||
            health.processAlive !== true ||
            health.token !== token ||
            health.transactionToken !== transactionToken ||
            health.pid !== applicationPid
          ) {
            throw new Error('Startup Health payload is invalid');
          }
          await sleep(500);
          if (!applicationIsAlive(child)) {
            throw new Error(
              'Application exited immediately after Startup Health'
            );
          }
          return {
            health: { ...health, processAlive: true, recovery },
            processIdentity,
          };
        }
        await sleep(100);
      }
      throw new Error('Startup Health deadline expired');
    } finally {
      fs.rmSync(healthPath, { force: true });
    }
  } finally {
    fs.rmSync(healthPath, { force: true });
    fs.rmSync(healthRequestPath, { force: true });
  }
}

async function recoverInterruptedProductionTransaction() {
  const paths = getProductionTransactionPaths();
  const result = await recoverInterruptedProductionUpdate({
    paths,
    terminateOwnedProcess: terminateProductionProcessHandle,
    processIsAlive: productionProcessIsAlive,
    discoverOwnedProcesses: discoverProductionProcesses,
    resolveLaunchExecutable: resolveProductionLaunchExecutable,
    launchAndWaitForHealth: launchAndWaitForProductionHealth,
    onDiagnostic: (message) => {
      logUpdater('Interrupted update recovery diagnostic', message);
      dialog.showErrorBox('Update Recovery Diagnostics', message);
    },
  });
  if (result.recovered) {
    logUpdater('Restored Last Known-Good from interrupted transaction');
    sendUpdaterStatus(
      'Previous Installation Restored',
      undefined,
      undefined,
      'Recovered an interrupted update and verified Startup Health'
    );
  }
  return result;
}

async function installPreparedProductionUpdate(
  prepared: PreparedProductionUpdate
) {
  const paths = getProductionTransactionPaths();
  const previousVersion = fs.existsSync('./version.txt')
    ? fs.readFileSync('./version.txt', 'utf8')
    : localVersion;
  try {
    return await coordinatePreparedProductionUpdate({
      prepared,
      paths,
      previousVersion,
      launchAndWaitForHealth: launchAndWaitForProductionHealth,
      terminateOwnedProcess: terminateProductionProcessHandle,
      processIsAlive: productionProcessIsAlive,
      discoverOwnedProcesses: discoverProductionProcesses,
      resolveLaunchExecutable: resolveProductionLaunchExecutable,
      commitMetadata: async () => {
        prepared.commitMetadata?.();
      },
      cleanupAfterCommit: async () => {
        cleanupAfterUpdate(prepared.tagName, prepared.assetName);
      },
      onDiagnostic: (message) => {
        logUpdater('Production update coordinator diagnostic', message);
        sendUpdaterFailure('Update Cleanup Requires Attention', message);
      },
    });
  } catch (error) {
    if (error?.transactionCommitted && error?.health?.processAlive === true) {
      return error.health;
    }
    throw error;
  }
}

async function activatePreparedUpdateOrLaunchExisting(
  prepared: PreparedProductionUpdate | undefined
) {
  if (!prepared) {
    launchApp(true);
    return;
  }
  productionTransactionAttempted = true;
  await installPreparedProductionUpdate(prepared);
  sendUpdaterStatus('Startup Health Confirmed');
  launchedApplication?.unref();
  app.exit(0);
}

async function downloadFullRelease(release: any) {
  const assetWithPortable = getPlatformAsset(release);
  if (!assetWithPortable) {
    throw new Error('No portable asset found for this platform');
  }
  const localCache = getVersionCache(release.tag_name);
  fs.mkdirSync(localCache, { recursive: true });
  const blockmapAsset = getBlockmapAsset(release, assetWithPortable);

  sendUpdaterStatus('Downloading Update');
  const workingPath =
    process.platform === 'win32'
      ? path.join(__dirname, 'update', 'OpenGameInstaller.exe')
      : path.join(__dirname, 'update', 'OpenGameInstaller.AppImage');
  const downloadPath = await stageVerifiedDownload({
    workingPath,
    stagingDirectory: path.join(__dirname, 'update-state', 'downloads'),
    expected: {
      size: assetWithPortable.size,
      digest: assetWithPortable.digest,
    },
    download: (destination) =>
      downloadToFile(
        assetWithPortable.browser_download_url,
        destination,
        'Downloading Update'
      ),
  });
  sendUpdaterStatus('Verifying Download');
  if (blockmapAsset) {
    await downloadToFile(
      blockmapAsset.browser_download_url,
      path.join(localCache, `${assetWithPortable.name}.blockmap`),
      'Downloading blockmap'
    );
  }
  sendUpdaterStatus('Download Complete');

  let candidateSourceDirectory = localCache;
  if (process.platform === 'win32') {
    sendUpdaterStatus('Extracting Update');
    candidateSourceDirectory = path.join(
      localCache,
      `extracted-${Date.now()}-${randomUUID()}`
    );
    await unzip(downloadPath, candidateSourceDirectory);
    const extractedLauncher = path.join(
      candidateSourceDirectory,
      'OpenGameInstaller.exe'
    );
    if (!fs.existsSync(extractedLauncher)) {
      throw new Error(
        'Verified Windows release is missing OpenGameInstaller.exe'
      );
    }
  }
  const candidatePath = await materializeProductionCandidate(
    candidateSourceDirectory,
    downloadPath
  );
  if (process.platform === 'win32') {
    fs.copyFileSync(
      downloadPath,
      path.join(localCache, assetWithPortable.name)
    );
  }
  fs.rmSync(downloadPath, { force: true });
  return {
    candidatePath,
    assetName: assetWithPortable.name,
    tagName: release.tag_name,
  } satisfies PreparedProductionUpdate;
}

async function applyBlockmapPath(releasePath: any, releases: any) {
  let currentTag = localVersion;
  let latestAssetName = null;
  let finalInstallationDirectory: string | null = null;
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
      throw new Error(`Release metadata missing for ${currentTag}`);
    }
    const fromCache = getVersionCache(currentTag);
    const nextCache = getVersionCache(nextRelease.tag_name);
    const currentAsset = getPlatformAsset(currentRelease);
    if (!currentAsset) {
      throw new Error(`Portable asset missing for ${currentTag}`);
    }
    const nextAsset = getPlatformAsset(nextRelease);
    if (!nextAsset) {
      throw new Error(`Portable asset missing for ${nextRelease.tag_name}`);
    }
    latestAssetName = nextAsset.name;
    const newBlockmapAsset = getBlockmapAsset(nextRelease, nextAsset);
    if (!newBlockmapAsset) {
      throw new Error(`Blockmap missing for ${nextRelease.tag_name}`);
    }
    const sourceArtifact = await ensureCachedSourceArtifact(
      fromCache,
      currentRelease,
      currentAsset
    );
    sendUpdaterStatus('Verifying base artifact');
    await verifyReleaseArtifact(
      sourceArtifact,
      {
        size: currentAsset.size,
        digest: currentAsset.digest,
      },
      'base artifact'
    );
    const oldBlockmapPath = await ensureCachedBlockmap(
      fromCache,
      currentRelease,
      currentAsset
    );
    fs.mkdirSync(nextCache, { recursive: true });
    const newBlockmapPath = path.join(nextCache, `${nextAsset.name}.blockmap`);
    if (!fs.existsSync(newBlockmapPath)) {
      await downloadToFile(
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
    await nextUiTick();
    await applyVerifiedBlockmapPatch({
      sourceArtifact,
      oldBlockmapPath,
      outputArtifact,
      newBlockmapPath,
      expectedArtifact: {
        size: nextAsset.size,
        digest: nextAsset.digest,
      },
      downloadRange: (start, end) =>
        downloadRangeChunk(nextAsset.browser_download_url, start, end),
      onProgress: (current, total) => {
        sendUpdaterStatus(
          `Building patch ${i + 1} of ${releasePath.length}`,
          current,
          total,
          nextRelease.tag_name
        );
      },
    });

    if (process.platform === 'win32') {
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
      await nextUiTick();
      finalInstallationDirectory = path.join(
        nextCache,
        `extracted-${Date.now()}-${randomUUID()}`
      );
      await unzip(outputArtifact, finalInstallationDirectory);
      resolveApplicationLauncher(finalInstallationDirectory, 'win32');
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
  const finalRelease = releasePath[releasePath.length - 1];
  const finalCache = getVersionCache(finalRelease.tag_name);
  const finalAsset = getPlatformAsset(finalRelease);
  if (!finalAsset) {
    throw new Error(`Portable asset missing for ${finalRelease.tag_name}`);
  }
  const sourceArtifact = path.join(finalCache, finalAsset.name);
  sendUpdaterStatus('Preparing Verified Candidate');
  const candidatePath = await materializeProductionCandidate(
    process.platform === 'win32'
      ? (finalInstallationDirectory ?? finalCache)
      : finalCache,
    process.platform === 'win32'
      ? sourceArtifact
      : path.join(finalCache, 'OpenGameInstaller.AppImage')
  );
  logUpdater('Incremental update candidate prepared', {
    finalTag: finalRelease.tag_name,
    latestAssetName,
    candidatePath,
  });
  return {
    candidatePath,
    assetName: finalAsset.name,
    tagName: finalRelease.tag_name,
  } satisfies PreparedProductionUpdate;
}

async function downloadRangeChunk(url, start, end) {
  const requestedRange = `bytes=${start}-${end}`;
  for (let attempt = 1; attempt <= HTTP_RETRY_ATTEMPTS; attempt++) {
    try {
      logUpdater('Requesting HTTP range', { url, requestedRange, attempt });
      const rangeResponse = await axios({
        url,
        method: 'GET',
        responseType: 'arraybuffer',
        headers: {
          Range: requestedRange,
          'Accept-Encoding': 'identity',
        },
        timeout: HTTP_REQUEST_TIMEOUT_MS,
        ...getAxiosTransportOptions(url),
      });
      const expectedSize = end - start + 1;
      const actualSize = Buffer.byteLength(rangeResponse.data);
      const contentRange = rangeResponse.headers['content-range'];
      const expectedContentRangePrefix = `bytes ${start}-${end}/`;
      if (rangeResponse.status !== 206) {
        throw new Error(
          `Invalid range response status ${rangeResponse.status} for ${requestedRange}`
        );
      }
      if (actualSize !== expectedSize) {
        throw new Error(
          `Invalid range response length ${actualSize} for ${requestedRange}; expected ${expectedSize}`
        );
      }
      if (
        typeof contentRange !== 'string' ||
        !contentRange.startsWith(expectedContentRangePrefix)
      ) {
        throw new Error(
          `Invalid content-range header for ${requestedRange}: ${contentRange}`
        );
      }
      logUpdater('Received HTTP range', {
        requestedRange,
        actualSize,
        contentRange,
        attempt,
      });
      return Buffer.from(rangeResponse.data);
    } catch (error) {
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
        throw error;
      }
      await sleep(getRetryDelay(attempt));
    }
  }
}

async function verifyReleaseArtifact(
  artifactPath,
  expectedArtifact,
  logLabel = 'release artifact'
) {
  try {
    await verifyVerifiedReleaseArtifact(artifactPath, expectedArtifact);
  } catch (error) {
    throw new Error(`${logLabel} verification failed: ${error.message}`, {
      cause: error,
    });
  }
}

/**
 * Launches the installed OpenGameInstaller, rotating logs, spawning the platform-specific executable in a detached process, and terminating the updater.
 *
 * Spawns OpenGameInstaller with `--online=<online>` as an argument.
 * @param {boolean} online - If true, start the application in online mode; otherwise start in offline mode.
 */
async function launchApp(online) {
  const effectiveOnline = getEffectiveOnlineState(online).effectiveOnline;
  console.log(
    'Launching in ' + (effectiveOnline ? 'online' : 'offline') + ' mode'
  );
  sendUpdaterStatus('Launching OpenGameInstaller');
  if (process.platform === 'win32') {
    if (
      !fs.existsSync(path.join(__dirname, 'update', 'OpenGameInstaller.exe'))
    ) {
      sendUpdaterFailure('Installation not found', 'Launch Failed');
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
      sendUpdaterFailure('Installation not found', 'Launch Failed');
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

function resolveZipEntryPath(unzipToDir, entryName) {
  const root = path.resolve(unzipToDir);
  const normalizedEntryName = entryName.replace(/\//g, path.sep);
  const fullPath = path.resolve(root, normalizedEntryName);
  const relativePath = path.relative(root, fullPath);

  if (
    relativePath.startsWith('..') ||
    path.isAbsolute(relativePath) ||
    relativePath === ''
  ) {
    throw new Error(`Unsafe zip entry path: ${entryName}`);
  }

  return fullPath;
}

app.on('ready', createWindow);
// taken from https://stackoverflow.com/questions/63932027/how-to-unzip-to-a-folder-using-yauzl
const unzip = (zipPath, unzipToDir) => {
  return new Promise<void>((resolve, reject) => {
    let zipFile: ZipFile | null = null;
    let filesProcessed = 0;
    let totalFiles = 0;
    logUpdater('Starting unzip', { zipPath, unzipToDir });

    try {
      // Create folder if not exists
      fs.mkdirSync(unzipToDir, { recursive: true });

      // Same as example we open the zip.
      yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
        if (err) {
          reject(err);
          return;
        }

        zipFile = zip;
        totalFiles = zipFile.entryCount;
        logUpdater('Opened zip archive', { zipPath, totalFiles });

        // This is the key. We start by reading the first entry.
        zipFile.readEntry();

        // Now for every entry, we will write a file or dir
        // to disk. Then call zipFile.readEntry() again to
        // trigger the next cycle.
        zipFile.on('entry', (entry) => {
          try {
            sendUpdaterStatus('Extracting Update', filesProcessed, totalFiles);
            const fullPath = resolveZipEntryPath(unzipToDir, entry.fileName);

            // Ensure the directory exists
            const dir = path.dirname(fullPath);
            if (!fs.existsSync(dir)) {
              fs.mkdirSync(dir, { recursive: true });
            }

            // check if entry is a directory
            if (/\/$/.test(entry.fileName)) {
              filesProcessed++;
              sendUpdaterStatus(
                'Extracting Update',
                filesProcessed,
                totalFiles
              );
              if (filesProcessed >= totalFiles) {
                logUpdater('Completed unzip', {
                  zipPath,
                  unzipToDir,
                  totalFiles,
                });
                zipFile.close();
                resolve();
                return;
              }
              zipFile.readEntry();
              return;
            }

            // Files
            zipFile.openReadStream(entry, (readErr, readStream) => {
              if (readErr) {
                zipFile.close();
                reject(readErr);
                return;
              }

              const file = fs.createWriteStream(fullPath);
              readStream.pipe(file);

              file.on('finish', () => {
                // Wait until the file is finished writing, then read the next entry.
                file.close((closeErr) => {
                  if (closeErr) {
                    zipFile.close();
                    reject(closeErr);
                    return;
                  }

                  filesProcessed++;
                  sendUpdaterStatus(
                    'Extracting Update',
                    filesProcessed,
                    totalFiles
                  );
                  if (filesProcessed >= totalFiles) {
                    logUpdater('Completed unzip', {
                      zipPath,
                      unzipToDir,
                      totalFiles,
                    });
                    zipFile.close();
                    resolve();
                    return;
                  }
                  zipFile.readEntry();
                });
              });

              file.on('error', (fileErr) => {
                zipFile.close();
                reject(fileErr);
              });

              readStream.on('error', (streamErr) => {
                file.destroy();
                zipFile.close();
                reject(streamErr);
              });
            });
          } catch (e) {
            zipFile.close();
            reject(e);
          }
        });

        zipFile.on('end', () => {
          if (zipFile) {
            zipFile.close();
          }
          resolve();
        });

        zipFile.on('error', (zipErr) => {
          if (zipFile) {
            zipFile.close();
          }
          reject(zipErr);
        });
      });
    } catch (e) {
      if (zipFile) {
        zipFile.close();
      }
      reject(e);
    }
  });
};
