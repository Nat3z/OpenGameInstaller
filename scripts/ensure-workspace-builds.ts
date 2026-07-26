import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { join, relative, resolve } from 'node:path';

export const WORKSPACE_BUILD_OUTPUTS = {
  '@ogi-sdk/addon-server': ['packages/addon-server/build/index.mjs'],
  '@ogi-sdk/client-kit': ['packages/client-kit/build/index.mjs'],
  '@ogi-sdk/connect': ['packages/connection/build/index.mjs'],
  '@ogi-sdk/executor': ['packages/executor/build/index.mjs'],
  'all-debrid-js': ['packages/all-debrid/build/main.mjs'],
  'ogi-addon': [
    'packages/ogi-addon/build/main.mjs',
    'packages/ogi-addon/build/config/Configuration.mjs',
  ],
  'real-debrid-js': ['packages/real-debrid/build/main.mjs'],
} as const;

export type WorkspacePackageName = keyof typeof WORKSPACE_BUILD_OUTPUTS;

const repositoryRoot = resolve(import.meta.dir, '..');
const buildFingerprintFile = '.ogi-workspace-build-fingerprint';
const defaultTimeoutMs = 10 * 60_000;
const lockMetadataGraceMs = 5_000;
// Longer than the 25-minute full CI budget, but bounded so copied caches recover.
const foreignOwnerMaxAgeMs = 30 * 60_000;
const ignoredInputDirectories = new Set(['build', 'node_modules', '.git']);
const sleepState = new Int32Array(new SharedArrayBuffer(4));

type SpawnBuild = typeof spawnSync;

export class WorkspaceBuildTimeoutError extends Error {
  readonly code = 'ETIMEDOUT';

  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceBuildTimeoutError';
  }
}

function packageDirectory(packageName: WorkspacePackageName): string {
  const firstOutput = WORKSPACE_BUILD_OUTPUTS[packageName][0];
  return firstOutput.split('/').slice(0, 2).join('/');
}

function fingerprintPath(root: string, packageName: WorkspacePackageName) {
  return join(
    root,
    packageDirectory(packageName),
    'build',
    buildFingerprintFile
  );
}

function listFingerprintInputs(root: string): string[] {
  const inputs = ['package.json', 'bun.lock', 'tsconfig.json']
    .map((path) => join(root, path))
    .filter(existsSync);
  const packagesDirectory = join(root, 'packages');

  function visit(directory: string) {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && ignoredInputDirectories.has(entry.name))
        continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) inputs.push(path);
    }
  }

  visit(packagesDirectory);
  return inputs.sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0
  );
}

export function computeWorkspaceBuildFingerprint(
  root = repositoryRoot
): string {
  const hash = createHash('sha256');
  for (const path of listFingerprintInputs(root)) {
    hash.update(relative(root, path).replaceAll('\\', '/'));
    hash.update('\0');
    hash.update(readFileSync(path));
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function missingWorkspaceBuildOutputs(
  packageNames: readonly WorkspacePackageName[],
  root = repositoryRoot,
  fileExists: (path: string) => boolean = existsSync
): string[] {
  return packageNames.flatMap((packageName) =>
    WORKSPACE_BUILD_OUTPUTS[packageName]
      .map((path) => join(root, path))
      .filter((path) => !fileExists(path))
  );
}

function workspaceBuildsAreFresh(
  packageNames: readonly WorkspacePackageName[],
  fingerprint: string,
  root: string,
  fileExists: (path: string) => boolean
): boolean {
  if (missingWorkspaceBuildOutputs(packageNames, root, fileExists).length > 0) {
    return false;
  }
  return packageNames.every((packageName) => {
    const marker = fingerprintPath(root, packageName);
    return (
      fileExists(marker) && readFileSync(marker, 'utf8').trim() === fingerprint
    );
  });
}

function writeBuildFingerprints(
  packageNames: readonly WorkspacePackageName[],
  fingerprint: string,
  root: string
) {
  for (const packageName of packageNames) {
    const marker = fingerprintPath(root, packageName);
    const temporaryMarker = `${marker}.${process.pid}.tmp`;
    mkdirSync(resolve(marker, '..'), { recursive: true });
    writeFileSync(temporaryMarker, `${fingerprint}\n`);
    rmSync(marker, { force: true });
    renameSync(temporaryMarker, marker);
  }
}

function remainingTime(deadline: number) {
  return Math.max(0, deadline - Date.now());
}

export function lockOwnerIsAlive(
  lockDirectory: string,
  now = Date.now(),
  graceMs = lockMetadataGraceMs,
  foreignMaxAgeMs = foreignOwnerMaxAgeMs
): boolean {
  const ownerPath = join(lockDirectory, 'owner.json');
  try {
    if (!existsSync(ownerPath)) {
      return now - statSync(lockDirectory).mtimeMs < graceMs;
    }
    const ownerAgeMs = now - statSync(ownerPath).mtimeMs;
    let owner: unknown;
    try {
      owner = JSON.parse(readFileSync(ownerPath, 'utf8'));
    } catch {
      return ownerAgeMs < graceMs;
    }
    if (
      typeof owner !== 'object' ||
      owner === null ||
      !('hostname' in owner) ||
      typeof owner.hostname !== 'string' ||
      owner.hostname.length === 0 ||
      !('pid' in owner) ||
      typeof owner.pid !== 'number' ||
      !Number.isInteger(owner.pid) ||
      owner.pid <= 0
    ) {
      return ownerAgeMs < graceMs;
    }
    if (owner.hostname !== hostname()) {
      return ownerAgeMs < foreignMaxAgeMs;
    }
    process.kill(owner.pid as number, 0);
    return true;
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    return code !== 'ENOENT' && code !== 'ESRCH';
  }
}

function acquireBuildLock(root: string, deadline: number): () => void {
  const cacheDirectory = join(root, 'node_modules', '.cache');
  const lockDirectory = join(cacheDirectory, 'ogi-workspace-build.lock');
  mkdirSync(cacheDirectory, { recursive: true });

  while (true) {
    try {
      mkdirSync(lockDirectory);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause;
      if (!lockOwnerIsAlive(lockDirectory)) {
        rmSync(lockDirectory, { force: true, recursive: true });
        continue;
      }
      if (remainingTime(deadline) === 0) {
        throw new WorkspaceBuildTimeoutError(
          'Timed out waiting for another workspace package build'
        );
      }
      Atomics.wait(sleepState, 0, 0, Math.min(100, remainingTime(deadline)));
      continue;
    }

    const ownerPath = join(lockDirectory, 'owner.json');
    const temporaryOwnerPath = `${ownerPath}.${process.pid}.tmp`;
    try {
      writeFileSync(
        temporaryOwnerPath,
        JSON.stringify({ hostname: hostname(), pid: process.pid })
      );
      renameSync(temporaryOwnerPath, ownerPath);
      return () => rmSync(lockDirectory, { force: true, recursive: true });
    } catch (cause) {
      rmSync(lockDirectory, { force: true, recursive: true });
      throw cause;
    }
  }
}

export function runWorkspacePackageBuild(
  packageNames: readonly WorkspacePackageName[],
  root: string,
  timeoutMs: number,
  spawnBuild: SpawnBuild = spawnSync
) {
  if (timeoutMs <= 0) {
    throw new WorkspaceBuildTimeoutError(
      'No time remains for the workspace package build'
    );
  }
  const arguments_ =
    packageNames.length === 1
      ? [
          'run',
          '--cwd',
          join(root, packageDirectory(packageNames[0]!)),
          'build',
        ]
      : ['run', '--filter', './packages/*', 'build'];
  const result = spawnBuild(process.execPath, arguments_, {
    cwd: root,
    stdio: 'inherit',
    timeout: timeoutMs,
    killSignal: 'SIGTERM',
  });
  if (
    (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT'
  ) {
    throw new WorkspaceBuildTimeoutError(
      `Workspace package build exceeded its ${timeoutMs}ms timeout`
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `Workspace package build failed with status ${result.status ?? 'unknown'}`
    );
  }
}

export function ensureWorkspaceBuilds(
  packageNames: readonly WorkspacePackageName[] = Object.keys(
    WORKSPACE_BUILD_OUTPUTS
  ) as WorkspacePackageName[],
  options: {
    root?: string;
    fileExists?: (path: string) => boolean;
    force?: boolean;
    timeoutMs?: number;
    runBuild?: (
      packageNames: readonly WorkspacePackageName[],
      timeoutMs: number
    ) => void;
  } = {}
): boolean {
  const root = options.root ?? repositoryRoot;
  const fileExists = options.fileExists ?? existsSync;
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  if (timeoutMs <= 0) {
    throw new WorkspaceBuildTimeoutError(
      'No time remains for workspace prerequisite preparation'
    );
  }
  const deadline = Date.now() + timeoutMs;
  const releaseLock = acquireBuildLock(root, deadline);
  try {
    const lockedFingerprint = computeWorkspaceBuildFingerprint(root);
    if (remainingTime(deadline) === 0) {
      throw new WorkspaceBuildTimeoutError(
        'Workspace fingerprinting exceeded the prerequisite timeout'
      );
    }
    if (
      !options.force &&
      workspaceBuildsAreFresh(packageNames, lockedFingerprint, root, fileExists)
    ) {
      process.stdout.write('Workspace package build outputs are fresh.\n');
      return false;
    }

    const runBuild =
      options.runBuild ??
      ((names: readonly WorkspacePackageName[], remainingMs: number) =>
        runWorkspacePackageBuild(names, root, remainingMs));
    runBuild(packageNames, remainingTime(deadline));

    const missingAfterBuild = missingWorkspaceBuildOutputs(
      packageNames,
      root,
      fileExists
    );
    if (missingAfterBuild.length > 0) {
      throw new Error(
        `Workspace package build did not create required outputs:\n${missingAfterBuild.join('\n')}`
      );
    }
    writeBuildFingerprints(
      packageNames,
      computeWorkspaceBuildFingerprint(root),
      root
    );
    return true;
  } finally {
    releaseLock();
  }
}

if (import.meta.main) {
  const force = process.argv.includes('--force');
  const requestedPackages = process.argv
    .slice(2)
    .filter((argument) => argument !== '--force');
  const packageNames =
    requestedPackages.length === 0
      ? (Object.keys(WORKSPACE_BUILD_OUTPUTS) as WorkspacePackageName[])
      : requestedPackages.map((packageName) => {
          if (!(packageName in WORKSPACE_BUILD_OUTPUTS)) {
            throw new Error(`Unknown workspace package: ${packageName}`);
          }
          return packageName as WorkspacePackageName;
        });
  ensureWorkspaceBuilds(packageNames, { force });
}
