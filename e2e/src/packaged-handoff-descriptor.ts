import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { gzipSync } from 'node:zlib';
import { blake2b } from 'blakejs';
import type { PackagedHandoffPlatform } from './packaged-handoff-fixtures';
import { getDefaultRunRoot } from './run-reliability';

export const RECOVERY_FAILURE_CASES = [
  'download',
  'incomplete-content',
  'unsafe-archive-path',
  'missing-required-file',
  'replacement',
  'crash',
  'pre-identity',
  'immediate-root-exit',
  'fork-during-scan',
  'timeout',
  'invalid-health',
] as const;
export type RecoveryFailureCase = (typeof RECOVERY_FAILURE_CASES)[number];
export const INCREMENTAL_UPDATE_MODES = [
  'none',
  'valid',
  'corrupt',
  'interrupted',
  'fallback-failure',
] as const;
export type IncrementalUpdateMode = (typeof INCREMENTAL_UPDATE_MODES)[number];

export type PackagedHandoffRunDescriptor = {
  version: 1;
  scenario: 'packaged-updater-application-handoff';
  runId: string;
  platform: PackagedHandoffPlatform;
  sandboxDirectory: string;
  updaterUserDataDirectory: string;
  applicationUserDataDirectory: string;
  applicationStateDirectory: string;
  packagedUpdaterDirectory: string;
  installationDirectory: string;
  applicationLauncherPath: string;
  backupDirectory: string;
  stagingDirectory: string;
  artifactDirectory: string;
  fixtureStateDirectory: string;
  eventLogPath: string;
  handoffLogPath: string;
  startupHealthPath: string;
  fixtureBaseUrl: string;
  releaseApiUrl: string;
  artifactUrl: string;
  automationPort: number;
  clientSdkPort: number;
  gameAutomationPort: number;
  healthTimeoutMs: number;
  recoveryFailure: 'none' | RecoveryFailureCase;
  incrementalUpdate: IncrementalUpdateMode;
  gameDownloadRecovery: boolean;
  fixtureGameLifecycle: boolean;
  offlineProductBehavior: boolean;
  deterministicTorrentInstallation: boolean;
  torrentUrl: string | null;
  torrentTrackerUrl: string | null;
  torrentPeerPort: number | null;
};

export type PackagedHandoffArtifactInput = {
  outputDirectory: string;
  applicationBundleDirectory: string;
  applicationMainPath: string;
  applicationOnlineStatePath: string;
  fixtureServicePath: string;
  trafficGuardPath: string;
  descriptorValidatorPath: string;
  updaterBundleDirectory: string;
  updaterPublicDirectory: string;
  updaterMainPath: string;
  updaterOfflineDecisionPath: string;
  fixtureAddonDirectory: string;
  fixtureWebSocketModuleDirectory: string;
  updaterUpdateEnginePath: string;
  updaterProductionCoordinatorPath?: string;
  updaterWindowsJobEvidencePath?: string;
};

export type PackagedHandoffBuild = {
  platform: PackagedHandoffPlatform;
  syntheticOldInstallationDirectory: string;
  incrementalOldInstallationDirectory: string;
  packagedUpdaterDirectory: string;
  incrementalOldApplicationArtifactPath: string;
  incrementalOldBlockmapPath: string;
  currentApplicationArtifactPath: string;
  incrementalPatchPath: string;
};

export type PackagedHandoffDescriptorWithPath = PackagedHandoffRunDescriptor & {
  descriptorPath: string;
};

export type PackagedApplicationLaunch = {
  entryPoint: string;
  args: string[];
  environment: { OGI_RUN_DESCRIPTOR: string };
};

export type StartupHealth = {
  version: 1;
  runId: string;
  state: 'interactive';
};

export type ArtifactFile = {
  path: string;
  mode: number;
  contents: string;
};

const require = createRequire(import.meta.url);
const { validatePackagedHandoffRunDescriptor } =
  require('./packaged-handoff-run-descriptor.cjs') as {
    validatePackagedHandoffRunDescriptor(
      value: unknown
    ): PackagedHandoffRunDescriptor;
  };

export function parsePackagedHandoffRunDescriptor(
  value: unknown
): PackagedHandoffRunDescriptor {
  return validatePackagedHandoffRunDescriptor(value);
}

export function readPackagedHandoffRunDescriptor(path: string) {
  return parsePackagedHandoffRunDescriptor(
    JSON.parse(readFileSync(path, 'utf8'))
  );
}

export function createPackagedHandoffSandbox(
  runId: string,
  platform: PackagedHandoffPlatform,
  ownedSandboxDirectory?: string,
  ownershipToken?: string
) {
  const runRoot = getDefaultRunRoot();
  mkdirSync(runRoot, { recursive: true });
  const sandboxDirectory = ownedSandboxDirectory
    ? resolve(ownedSandboxDirectory)
    : mkdtempSync(join(runRoot, `product-journey-${runId}-`));
  if (ownedSandboxDirectory) {
    if (!ownershipToken) {
      throw new Error(
        'Owned Product Journey sandbox requires an ownership token'
      );
    }
    const relativeSandbox = relative(resolve(runRoot), sandboxDirectory);
    if (
      relativeSandbox === '' ||
      relativeSandbox.startsWith('..') ||
      isAbsolute(relativeSandbox)
    ) {
      throw new Error(
        'Owned Product Journey sandbox must remain under the run root'
      );
    }
    mkdirSync(sandboxDirectory);
    writeFileSync(
      join(sandboxDirectory, '.ogi-attempt-owner.json'),
      JSON.stringify({
        version: 1,
        token: ownershipToken,
        sandboxDirectory,
      }),
      { flag: 'wx', mode: 0o400 }
    );
  }
  const descriptorPath = join(sandboxDirectory, 'run-descriptor.json');
  const fixtureBaseUrl = 'http://127.0.0.1:1';
  const descriptor = parsePackagedHandoffRunDescriptor({
    version: 1,
    scenario: 'packaged-updater-application-handoff',
    runId,
    platform,
    sandboxDirectory,
    updaterUserDataDirectory: join(sandboxDirectory, 'updater-user-data'),
    applicationUserDataDirectory: join(
      sandboxDirectory,
      'application-user-data'
    ),
    applicationStateDirectory: join(sandboxDirectory, 'application-state'),
    packagedUpdaterDirectory: join(sandboxDirectory, 'packaged-updater'),
    installationDirectory: join(sandboxDirectory, 'installation'),
    applicationLauncherPath: join(
      sandboxDirectory,
      'installation',
      launcherName(platform)
    ),
    backupDirectory: join(sandboxDirectory, 'last-known-good'),
    stagingDirectory: join(sandboxDirectory, 'staging'),
    artifactDirectory: join(sandboxDirectory, 'artifacts'),
    fixtureStateDirectory: join(sandboxDirectory, 'fixture-state'),
    eventLogPath: join(sandboxDirectory, 'events.jsonl'),
    handoffLogPath: join(sandboxDirectory, 'artifacts', 'handoff.jsonl'),
    startupHealthPath: join(sandboxDirectory, 'startup-health.json'),
    fixtureBaseUrl,
    releaseApiUrl: `${fixtureBaseUrl}/releases`,
    artifactUrl: `${fixtureBaseUrl}/artifacts/current.json`,
    automationPort: 9222,
    clientSdkPort: 7654,
    gameAutomationPort: 9333,
    healthTimeoutMs: 30000,
    recoveryFailure: 'none',
    incrementalUpdate: 'none',
    gameDownloadRecovery: false,
    fixtureGameLifecycle: false,
    offlineProductBehavior: false,
    deterministicTorrentInstallation: false,
    torrentUrl: null,
    torrentTrackerUrl: null,
    torrentPeerPort: null,
  });
  for (const directory of [
    descriptor.updaterUserDataDirectory,
    descriptor.applicationUserDataDirectory,
    descriptor.applicationStateDirectory,
    descriptor.packagedUpdaterDirectory,
    descriptor.installationDirectory,
    descriptor.stagingDirectory,
    descriptor.artifactDirectory,
    descriptor.fixtureStateDirectory,
  ]) {
    mkdirSync(directory, { recursive: true });
  }
  writeFileSync(descriptorPath, JSON.stringify(descriptor, null, 2));
  return { ...descriptor, descriptorPath };
}

export function writePackagedHandoffRunDescriptor(
  descriptor: PackagedHandoffDescriptorWithPath,
  fixtureBaseUrl: string,
  automationPort: number,
  clientSdkPort: number,
  gameAutomationPort: number,
  recoveryFailure: 'none' | RecoveryFailureCase = 'none',
  gameDownloadRecovery = false,
  fixtureGameLifecycle = false,
  offlineProductBehavior = false,
  incrementalUpdate: IncrementalUpdateMode = 'none',
  deterministicTorrentInstallation = false,
  torrent: {
    torrentUrl: string;
    trackerUrl: string;
    peerPort: number;
  } | null = null
) {
  const { descriptorPath, ...current } = descriptor;
  const configured = parsePackagedHandoffRunDescriptor({
    ...current,
    fixtureBaseUrl,
    releaseApiUrl: `${fixtureBaseUrl}/releases`,
    artifactUrl: `${fixtureBaseUrl}/artifacts/current.json`,
    automationPort,
    clientSdkPort,
    gameAutomationPort,
    recoveryFailure,
    incrementalUpdate,
    gameDownloadRecovery,
    fixtureGameLifecycle,
    offlineProductBehavior,
    deterministicTorrentInstallation,
    torrentUrl: torrent?.torrentUrl ?? null,
    torrentTrackerUrl: torrent?.trackerUrl ?? null,
    torrentPeerPort: torrent?.peerPort ?? null,
    healthTimeoutMs:
      recoveryFailure === 'none'
        ? current.healthTimeoutMs
        : ['immediate-root-exit', 'fork-during-scan'].includes(recoveryFailure)
          ? 5000
          : 2000,
  });
  writeFileSync(descriptorPath, JSON.stringify(configured, null, 2));
  return { ...configured, descriptorPath };
}

export function collectArtifactFiles(root: string, destinationRoot: string) {
  const files: ArtifactFile[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const sourcePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(sourcePath);
        continue;
      }
      const destinationPath = join(
        destinationRoot,
        relative(root, sourcePath)
      ).replaceAll('\\', '/');
      files.push({
        path: destinationPath,
        mode: statSync(sourcePath).mode & 0o777,
        contents: readFileSync(sourcePath).toString('base64'),
      });
    }
  };
  visit(root);
  return files;
}

export function artifactFile(sourcePath: string, destinationPath: string) {
  return {
    path: destinationPath,
    mode: statSync(sourcePath).mode & 0o777,
    contents: readFileSync(sourcePath).toString('base64'),
  };
}

export function launcherName(platform: PackagedHandoffPlatform) {
  return platform === 'win32'
    ? 'OpenGameInstaller.exe'
    : 'OpenGameInstaller.AppImage';
}

export function lastKnownGoodLauncherName(platform: PackagedHandoffPlatform) {
  return launcherName(platform);
}

export function fixtureBlockmap(contents: Buffer, sizes: number[]) {
  let offset = 0;
  const normalizedSizes = sizes.filter((size) => size > 0);
  const checksums = normalizedSizes.map((size) => {
    const checksum = Buffer.from(
      blake2b(contents.subarray(offset, offset + size), undefined, 18)
    ).toString('base64');
    offset += size;
    return checksum;
  });
  if (offset !== contents.byteLength) {
    throw new Error('Fixture blockmap sizes do not describe the artifact');
  }
  return gzipSync(
    JSON.stringify({
      version: '2',
      files: [{ name: 'file', offset: 0, sizes: normalizedSizes, checksums }],
    })
  );
}

export function compatibleBlockSizes(base: Buffer, target: Buffer) {
  let prefix = 0;
  while (
    prefix < base.byteLength &&
    prefix < target.byteLength &&
    base[prefix] === target[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < base.byteLength - prefix &&
    suffix < target.byteLength - prefix &&
    base[base.byteLength - suffix - 1] ===
      target[target.byteLength - suffix - 1]
  ) {
    suffix += 1;
  }
  return {
    base: [prefix, base.byteLength - prefix - suffix, suffix],
    target: [prefix, target.byteLength - prefix - suffix, suffix],
  };
}
