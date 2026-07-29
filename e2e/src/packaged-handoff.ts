import { createHash } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { blake2b } from 'blakejs';
import { resolveElectronExecutable } from '../electron-service-options';
import {
  FIXTURE_GAME_CONTENT,
  FIXTURE_GAME_MAIN,
  FIXTURE_GAME_TERMINATION_BYTES,
  FIXTURE_TORRENT_PAYLOAD_MANIFEST,
  type FixturePayloadManifestEntry,
  type PackagedHandoffPlatform,
  verifyExactFixtureTree,
} from './packaged-handoff-fixtures';
import { getDefaultRunRoot } from './run-reliability';

export type {
  FixturePayloadManifestEntry,
  PackagedHandoffPlatform,
  TorrentLibraryRecord,
} from './packaged-handoff-fixtures';
export {
  FIXTURE_GAME_CONTENT,
  FIXTURE_GAME_MAIN,
  FIXTURE_GAME_TERMINATION_BYTES,
  FIXTURE_TORRENT_PAYLOAD_MANIFEST,
  verifyExactFixtureTree,
  verifyExactTorrentLibraryState,
} from './packaged-handoff-fixtures';

import {
  type ArtifactFile,
  artifactFile,
  collectArtifactFiles,
  compatibleBlockSizes,
  fixtureBlockmap,
  INCREMENTAL_UPDATE_MODES,
  type IncrementalUpdateMode,
  lastKnownGoodLauncherName,
  launcherName,
  type PackagedApplicationLaunch,
  type PackagedHandoffArtifactInput,
  type PackagedHandoffBuild,
  type PackagedHandoffDescriptorWithPath,
  type PackagedHandoffRunDescriptor,
  parsePackagedHandoffRunDescriptor,
  RECOVERY_FAILURE_CASES,
  type RecoveryFailureCase,
  readPackagedHandoffRunDescriptor,
  type StartupHealth,
} from './packaged-handoff-descriptor';

export type {
  IncrementalUpdateMode,
  PackagedApplicationLaunch,
  PackagedHandoffBuild,
  PackagedHandoffRunDescriptor,
  RecoveryFailureCase,
} from './packaged-handoff-descriptor';
export {
  createPackagedHandoffSandbox,
  INCREMENTAL_UPDATE_MODES,
  parsePackagedHandoffRunDescriptor,
  RECOVERY_FAILURE_CASES,
  readPackagedHandoffRunDescriptor,
  writePackagedHandoffRunDescriptor,
} from './packaged-handoff-descriptor';

export function signalProductJourneyCompletion(fixtureStateDirectory: string) {
  const path = join(fixtureStateDirectory, 'journey-complete.json');
  writeFileSync(path, JSON.stringify({ version: 1, completed: true }));
  return path;
}

export async function disconnectProductJourneyBrowser(
  browser:
    | {
        disconnect: () => void | Promise<void>;
        close?: () => void | Promise<void>;
      }
    | undefined
) {
  await browser?.disconnect();
}

export async function completeProductJourneyAutomation(
  browser:
    | {
        disconnect: () => void | Promise<void>;
      }
    | undefined,
  fixtureStateDirectory: string
) {
  await disconnectProductJourneyBrowser(browser);
  return signalProductJourneyCompletion(fixtureStateDirectory);
}

export function getProductJourneyLaunch(options: {
  hostPlatform: NodeJS.Platform;
  electronExecutable?: string;
}) {
  if (options.hostPlatform === 'linux') {
    return {
      command: 'xvfb-run',
      args: ['-a', 'bunx', 'wdio', 'run', './product-journey-wdio.conf.ts'],
      detached: true,
      environment: {},
    };
  }
  if (options.hostPlatform === 'win32') {
    return {
      command: 'powershell.exe',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        '../updater/src/windows-job-wrapper.ps1',
        'bunx',
        'wdio',
        'run',
        './product-journey-wdio.conf.ts',
      ],
      detached: false,
      environment: {},
    };
  }
  if (options.hostPlatform === 'darwin') {
    return {
      command: options.electronExecutable ?? resolveElectronExecutable(),
      args: [
        '-e',
        "import('@wdio/cli').then(({ run }) => run())",
        '--',
        'run',
        './product-journey-wdio.conf.ts',
      ],
      detached: true,
      environment: { ELECTRON_RUN_AS_NODE: '1' },
    };
  }
  return {
    command: 'bunx',
    args: ['wdio', 'run', './product-journey-wdio.conf.ts'],
    detached: true,
    environment: {},
  };
}

function failureDetail(cause: unknown): string {
  if (cause instanceof Error && cause.message) return cause.message;
  if (typeof cause !== 'object' || cause === null) return String(cause ?? '');
  const record = cause as {
    _tag?: unknown;
    status?: unknown;
    signal?: unknown;
    cause?: unknown;
  };
  const ownDetail =
    typeof record._tag === 'string' && record._tag.endsWith('ProcessExitError')
      ? `${record._tag} exited with status ${String(record.status)} and signal ${String(record.signal)}`
      : JSON.stringify(cause);
  const nestedDetail =
    record.cause === undefined ? '' : failureDetail(record.cause);
  return nestedDetail && nestedDetail !== ownDetail
    ? `${ownDetail}; ${nestedDetail}`
    : ownDetail;
}

export function summarizeProductJourneyProcessFailure(
  failure: unknown,
  processFailure?: unknown
) {
  const primary = failureDetail(failure);
  const process = failureDetail(processFailure);
  return process && process !== primary ? `${primary}; ${process}` : primary;
}

export function buildPackagedHandoffArtifacts(
  input: PackagedHandoffArtifactInput
): PackagedHandoffBuild[] {
  mkdirSync(input.outputDirectory, { recursive: true });
  return (['linux', 'win32'] as const).map((platform) => {
    const platformDirectory = join(input.outputDirectory, platform);
    const syntheticOldInstallationDirectory = join(
      platformDirectory,
      'synthetic-old'
    );
    const incrementalOldInstallationDirectory = join(
      platformDirectory,
      'incremental-old'
    );
    const packagedUpdaterDirectory = join(platformDirectory, 'updater');
    rmSync(platformDirectory, { recursive: true, force: true });
    mkdirSync(syntheticOldInstallationDirectory, { recursive: true });
    writeFileSync(
      join(syntheticOldInstallationDirectory, 'version.txt'),
      'v0.0.1-e2e'
    );
    const oldLauncher = join(
      syntheticOldInstallationDirectory,
      lastKnownGoodLauncherName(platform)
    );
    writeFileSync(
      oldLauncher,
      platform === 'linux'
        ? '#!/bin/sh\nprintf "synthetic old installation\\n"\n'
        : '@echo off\r\necho synthetic old installation\r\n'
    );
    if (platform === 'linux') chmodSync(oldLauncher, 0o755);
    cpSync(
      input.updaterBundleDirectory,
      join(packagedUpdaterDirectory, 'dist'),
      {
        recursive: true,
      }
    );
    cpSync(
      input.updaterPublicDirectory,
      join(packagedUpdaterDirectory, 'public'),
      { recursive: true }
    );
    cpSync(
      input.updaterMainPath,
      join(packagedUpdaterDirectory, 'e2e-product-main.cjs')
    );
    writeFileSync(
      join(packagedUpdaterDirectory, 'package.json'),
      JSON.stringify({ type: 'module' })
    );
    mkdirSync(join(packagedUpdaterDirectory, 'support'), { recursive: true });
    cpSync(
      input.descriptorValidatorPath,
      join(
        packagedUpdaterDirectory,
        'support/packaged-handoff-run-descriptor.cjs'
      )
    );
    cpSync(
      input.trafficGuardPath,
      join(packagedUpdaterDirectory, 'support/offline-traffic-guard.cjs')
    );
    cpSync(
      input.updaterOfflineDecisionPath,
      join(packagedUpdaterDirectory, 'support/updater-offline-decision.js')
    );
    const onlineStatePackageDirectory = join(
      packagedUpdaterDirectory,
      'node_modules/@ogi/online-state'
    );
    mkdirSync(join(onlineStatePackageDirectory, 'build'), { recursive: true });
    cpSync(
      input.applicationOnlineStatePath,
      join(onlineStatePackageDirectory, 'build/index.js')
    );
    cpSync(
      join(
        resolve(dirname(input.applicationOnlineStatePath), '..'),
        'package.json'
      ),
      join(onlineStatePackageDirectory, 'package.json')
    );
    cpSync(
      input.updaterUpdateEnginePath,
      join(packagedUpdaterDirectory, 'support/update-engine.mjs')
    );
    cpSync(
      input.updaterProductionCoordinatorPath ??
        join(
          dirname(input.updaterUpdateEnginePath),
          'production-update-coordinator.mjs'
        ),
      join(
        packagedUpdaterDirectory,
        'support/production-update-coordinator.mjs'
      )
    );
    cpSync(
      input.updaterWindowsJobEvidencePath ??
        join(
          dirname(input.updaterUpdateEnginePath),
          'windows-job-evidence.mjs'
        ),
      join(packagedUpdaterDirectory, 'support/windows-job-evidence.mjs')
    );
    const blakePackageDirectory = resolve(
      dirname(require.resolve('blakejs/package.json'))
    );
    cpSync(
      blakePackageDirectory,
      join(packagedUpdaterDirectory, 'node_modules/blakejs'),
      { recursive: true }
    );

    const files = [
      ...collectArtifactFiles(input.applicationBundleDirectory, 'app/out'),
      ...collectArtifactFiles(
        input.fixtureAddonDirectory,
        'app/ogi-e2e-fixture-addon'
      ),
      ...collectArtifactFiles(
        input.fixtureWebSocketModuleDirectory,
        'support/node_modules/ws'
      ),
      artifactFile(input.applicationMainPath, 'app/e2e-product-main.cjs'),
      artifactFile(
        input.applicationOnlineStatePath,
        'support/application-online-state.js'
      ),
      artifactFile(input.fixtureServicePath, 'support/fixture-service.cjs'),
      artifactFile(input.trafficGuardPath, 'support/offline-traffic-guard.cjs'),
      artifactFile(
        input.descriptorValidatorPath,
        'support/packaged-handoff-run-descriptor.cjs'
      ),
      {
        path: launcherName(platform),
        mode: platform === 'linux' ? 0o755 : 0o644,
        contents: Buffer.from(
          platform === 'linux'
            ? '#!/bin/sh\nexec "$OGI_E2E_ELECTRON" --no-sandbox "$(dirname "$0")/app/e2e-product-main.cjs" "$@"\n'
            : 'MZ\\0\\0OpenGameInstaller E2E executable fixture'
        ).toString('base64'),
      },
    ];
    for (const file of files) {
      const destination = containedArtifactPath(
        syntheticOldInstallationDirectory,
        file.path
      );
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, Buffer.from(file.contents, 'base64'));
      chmodSync(destination, file.mode);
    }
    const artifactForVersion = (version: string) =>
      Buffer.from(
        JSON.stringify({
          formatVersion: 1,
          product: 'OpenGameInstaller',
          platform,
          version,
          entryPoint: 'app/e2e-product-main.cjs',
          executable: launcherName(platform),
          files,
        })
      );
    const incrementalOldApplicationArtifactPath = join(
      platformDirectory,
      `OpenGameInstaller-${platform}-v4.0.0-e2e.json`
    );
    const currentApplicationArtifactPath = join(
      platformDirectory,
      `OpenGameInstaller-${platform}-e2e.json`
    );
    const incrementalOldBlockmapPath = `${incrementalOldApplicationArtifactPath}.blockmap`;
    const incrementalPatchPath = `${currentApplicationArtifactPath}.blockmap`;
    mkdirSync(platformDirectory, { recursive: true });
    const incrementalOldArtifact = artifactForVersion('v4.0.0-e2e');
    const currentArtifact = artifactForVersion('v4.1.0-e2e');
    writeFileSync(
      incrementalOldApplicationArtifactPath,
      incrementalOldArtifact
    );
    writeFileSync(currentApplicationArtifactPath, currentArtifact);
    const blockSizes = compatibleBlockSizes(
      incrementalOldArtifact,
      currentArtifact
    );
    writeFileSync(
      incrementalOldBlockmapPath,
      fixtureBlockmap(incrementalOldArtifact, blockSizes.base)
    );
    writeFileSync(
      incrementalPatchPath,
      fixtureBlockmap(currentArtifact, blockSizes.target)
    );
    cpSync(
      syntheticOldInstallationDirectory,
      incrementalOldInstallationDirectory,
      { recursive: true }
    );
    writeFileSync(
      join(incrementalOldInstallationDirectory, 'version.txt'),
      'v4.0.0-e2e'
    );
    writeFileSync(
      join(incrementalOldInstallationDirectory, 'source-artifact.json'),
      incrementalOldArtifact
    );
    for (const file of files) {
      const destination = containedArtifactPath(
        incrementalOldInstallationDirectory,
        file.path
      );
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, Buffer.from(file.contents, 'base64'));
      chmodSync(destination, file.mode);
    }
    return {
      platform,
      syntheticOldInstallationDirectory,
      incrementalOldInstallationDirectory,
      packagedUpdaterDirectory,
      incrementalOldApplicationArtifactPath,
      incrementalOldBlockmapPath,
      currentApplicationArtifactPath,
      incrementalPatchPath,
    };
  });
}

export function copySyntheticOldInstallation(
  sourceDirectory: string,
  installationDirectory: string
) {
  rmSync(installationDirectory, { recursive: true, force: true });
  cpSync(sourceDirectory, installationDirectory, { recursive: true });
}

function containedArtifactPath(root: string, artifactPath: string) {
  const destination = resolve(root, artifactPath);
  const fromRoot = relative(resolve(root), destination);
  if (fromRoot === '' || fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
    throw new Error(`Packaged application path is unsafe: ${artifactPath}`);
  }
  return destination;
}

function stagePackagedApplication(
  descriptor: PackagedHandoffDescriptorWithPath,
  artifactPath: string
) {
  const artifact = JSON.parse(readFileSync(artifactPath, 'utf8')) as {
    formatVersion: number;
    platform: string;
    version: string;
    entryPoint: string;
    executable: string;
    files: ArtifactFile[];
  };
  if (
    artifact.formatVersion !== 1 ||
    artifact.platform !== descriptor.platform ||
    artifact.version !== 'v4.1.0-e2e' ||
    artifact.entryPoint !== 'app/e2e-product-main.cjs' ||
    artifact.executable !== launcherName(descriptor.platform) ||
    !Array.isArray(artifact.files)
  ) {
    throw new Error('Packaged application artifact is invalid');
  }

  const validatedFiles = artifact.files.map((file) => {
    if (
      typeof file.path !== 'string' ||
      typeof file.contents !== 'string' ||
      !Number.isInteger(file.mode)
    ) {
      throw new Error('Packaged application file entry is invalid');
    }
    return {
      ...file,
      destination: containedArtifactPath(
        descriptor.stagingDirectory,
        file.path
      ),
    };
  });
  containedArtifactPath(descriptor.stagingDirectory, artifact.executable);
  const artifactPaths = new Set(validatedFiles.map((file) => file.path));
  const requiredPaths = [
    artifact.entryPoint,
    'app/out/preload/index.mjs',
    'app/out/renderer/index.html',
    'support/application-online-state.js',
    'support/fixture-service.cjs',
    'support/offline-traffic-guard.cjs',
    'support/packaged-handoff-run-descriptor.cjs',
    launcherName(descriptor.platform),
  ];
  const missingRequiredPath = requiredPaths.find(
    (requiredPath) => !artifactPaths.has(requiredPath)
  );
  if (missingRequiredPath) {
    throw new Error(
      `Packaged application artifact is missing required file: ${missingRequiredPath}`
    );
  }

  rmSync(descriptor.stagingDirectory, { recursive: true, force: true });
  mkdirSync(descriptor.stagingDirectory, { recursive: true });
  try {
    for (const file of validatedFiles) {
      mkdirSync(join(file.destination, '..'), { recursive: true });
      writeFileSync(file.destination, Buffer.from(file.contents, 'base64'));
      chmodSync(file.destination, file.mode);
    }
    writeFileSync(
      join(descriptor.stagingDirectory, 'version.txt'),
      artifact.version
    );
    const launcher = containedArtifactPath(
      descriptor.stagingDirectory,
      artifact.executable
    );
    if (!existsSync(launcher)) {
      throw new Error(
        `Packaged application launcher is missing: ${artifact.executable}`
      );
    }
    return {
      entryPoint: containedArtifactPath(
        descriptor.stagingDirectory,
        artifact.entryPoint
      ),
    };
  } catch (cause) {
    rmSync(descriptor.stagingDirectory, { recursive: true, force: true });
    throw cause;
  }
}

export function installPackagedApplicationArtifact(
  descriptor: PackagedHandoffDescriptorWithPath,
  artifactPath: string
) {
  const staged = stagePackagedApplication(descriptor, artifactPath);
  rmSync(descriptor.installationDirectory, { recursive: true, force: true });
  renameSync(descriptor.stagingDirectory, descriptor.installationDirectory);
  return join(
    descriptor.installationDirectory,
    relative(descriptor.stagingDirectory, staged.entryPoint)
  );
}

export function seedOfflineFixtureGame(
  descriptor: PackagedHandoffDescriptorWithPath,
  electronPath: string
) {
  const installRoot = join(descriptor.sandboxDirectory, 'downloads');
  const installDirectory = join(installRoot, 'Golden Journey Fixture');
  const launchExecutable = join(
    installDirectory,
    descriptor.platform === 'win32' ? 'fixture-game.cmd' : 'fixture-game.sh'
  );
  const fixtureMainPath = join(installDirectory, 'fixture-game.cjs');
  const markerPath = join(
    descriptor.fixtureStateDirectory,
    'fixture-game-launch.json'
  );
  mkdirSync(installDirectory, { recursive: true });
  writeFileSync(
    join(installDirectory, 'golden-journey.txt'),
    FIXTURE_GAME_CONTENT
  );
  writeFileSync(fixtureMainPath, FIXTURE_GAME_MAIN);
  const launchArguments = [
    `--remote-debugging-port=${descriptor.gameAutomationPort}`,
    `--marker=${markerPath}`,
  ];
  writeFileSync(
    launchExecutable,
    descriptor.platform === 'win32'
      ? `@echo off\r\n"${electronPath}" "${fixtureMainPath}" ${launchArguments
          .map((argument) => `"${argument}"`)
          .join(' ')}\r\n`
      : `#!/bin/sh\nexec "${electronPath}" --no-sandbox "${fixtureMainPath}" ${launchArguments
          .map((argument) => `"${argument}"`)
          .join(' ')}\n`
  );
  if (descriptor.platform === 'linux') chmodSync(launchExecutable, 0o755);

  const optionDirectory = join(
    descriptor.applicationStateDirectory,
    'config/option'
  );
  mkdirSync(optionDirectory, { recursive: true });
  writeFileSync(
    join(optionDirectory, 'installed.json'),
    JSON.stringify({ installed: true })
  );
  writeFileSync(
    join(optionDirectory, 'general.json'),
    JSON.stringify({
      addons: [],
      fileDownloadLocation: installRoot,
    })
  );
  const libraryDirectory = join(
    descriptor.applicationStateDirectory,
    'library'
  );
  mkdirSync(libraryDirectory, { recursive: true });
  const libraryPath = join(libraryDirectory, '7001.json');
  const localImage =
    'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="375" height="500"%3E%3Crect width="100%25" height="100%25" fill="%236d5dfc"/%3E%3C/svg%3E';
  writeFileSync(
    libraryPath,
    JSON.stringify(
      {
        cwd: installDirectory,
        installDirectory,
        launchExecutable,
        version: '1.0.0',
        installRoot,
        capsuleImage: localImage,
        coverImage: localImage,
        name: 'Golden Journey Fixture',
        appID: 7001,
        storefront: 'ogi-e2e',
        addonsource: 'ogi-e2e-fixture-addon',
      },
      null,
      2
    )
  );
  return { installDirectory, launchExecutable, libraryPath };
}

async function waitForStartupHealth(
  descriptor: PackagedHandoffDescriptorWithPath
): Promise<StartupHealth> {
  const deadline = Date.now() + descriptor.healthTimeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(descriptor.startupHealthPath)) {
      const value = JSON.parse(
        readFileSync(descriptor.startupHealthPath, 'utf8')
      ) as StartupHealth;
      if (
        value.version === 1 &&
        value.runId === descriptor.runId &&
        value.state === 'interactive'
      ) {
        return value;
      }
      throw new Error('Startup Health Signal is invalid');
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Startup Health Signal did not arrive before the deadline');
}

export type RecoveryPhase =
  | 'recovery-started'
  | 'last-known-good-restored'
  | 'last-known-good-launched';

export async function performRecoverableHandoff(input: {
  descriptor: PackagedHandoffDescriptorWithPath;
  currentApplicationArtifactPath: string;
  launchApplication: (launch: PackagedApplicationLaunch) => Promise<void>;
  replaceInstallation?: () => void;
  launchLastKnownGood?: (entryPoint: string) => Promise<void>;
  onRecoveryPhase?: (phase: RecoveryPhase) => void;
}) {
  const staged = stagePackagedApplication(
    input.descriptor,
    input.currentApplicationArtifactPath
  );
  rmSync(input.descriptor.backupDirectory, { recursive: true, force: true });
  cpSync(
    input.descriptor.installationDirectory,
    input.descriptor.backupDirectory,
    { recursive: true }
  );

  try {
    if (input.replaceInstallation) {
      input.replaceInstallation();
    } else {
      rmSync(input.descriptor.installationDirectory, {
        recursive: true,
        force: true,
      });
      renameSync(
        input.descriptor.stagingDirectory,
        input.descriptor.installationDirectory
      );
    }
    const entryPoint = join(
      input.descriptor.installationDirectory,
      relative(input.descriptor.stagingDirectory, staged.entryPoint)
    );
    await input.launchApplication({
      entryPoint,
      args: [
        `--remote-debugging-port=${input.descriptor.automationPort}`,
        ...(input.descriptor.platform === 'linux' ? ['--no-sandbox'] : []),
      ],
      environment: {
        OGI_RUN_DESCRIPTOR: input.descriptor.descriptorPath,
      },
    });
    const health = await waitForStartupHealth(input.descriptor);
    rmSync(input.descriptor.backupDirectory, { recursive: true, force: true });
    return { health, entryPoint };
  } catch (cause) {
    input.onRecoveryPhase?.('recovery-started');
    rmSync(input.descriptor.installationDirectory, {
      recursive: true,
      force: true,
    });
    renameSync(
      input.descriptor.backupDirectory,
      input.descriptor.installationDirectory
    );
    rmSync(input.descriptor.stagingDirectory, { recursive: true, force: true });
    rmSync(input.descriptor.startupHealthPath, { force: true });
    input.onRecoveryPhase?.('last-known-good-restored');
    if (input.launchLastKnownGood) {
      await input.launchLastKnownGood(
        join(
          input.descriptor.installationDirectory,
          lastKnownGoodLauncherName(input.descriptor.platform)
        )
      );
      input.onRecoveryPhase?.('last-known-good-launched');
    }
    throw cause;
  }
}

export async function startPackagedHandoffFixture(
  fixtureStateDirectory: string,
  currentApplicationArtifactPath: string,
  holdGameDownloadAtTerminationPoint = false,
  incrementalPatchPath?: string,
  incrementalUpdate: IncrementalUpdateMode = 'none',
  incrementalOldBlockmapPath?: string,
  deterministicTorrentInstallation = false
) {
  mkdirSync(fixtureStateDirectory, { recursive: true });
  const requestLogPath = join(fixtureStateDirectory, 'requests.jsonl');
  writeFileSync(requestLogPath, '');
  const artifactContents = readFileSync(currentApplicationArtifactPath);
  const patchContents = incrementalPatchPath
    ? readFileSync(incrementalPatchPath)
    : undefined;
  const oldBlockmapContents = incrementalOldBlockmapPath
    ? readFileSync(incrementalOldBlockmapPath)
    : undefined;
  const oldArtifactContents = incrementalOldBlockmapPath
    ? readFileSync(incrementalOldBlockmapPath.slice(0, -'.blockmap'.length))
    : undefined;
  const artifactDigest = `sha256:${createHash('sha256')
    .update(artifactContents)
    .digest('hex')}`;
  const oldArtifactDigest = oldArtifactContents
    ? `sha256:${createHash('sha256').update(oldArtifactContents).digest('hex')}`
    : undefined;
  let torrentContents: Buffer | undefined;
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
    const isReleases =
      request.method === 'GET' && requestUrl.pathname === '/releases';
    const isArtifact =
      request.method === 'GET' &&
      requestUrl.pathname === '/artifacts/current.json';
    const isIncrementalPatch =
      request.method === 'GET' &&
      requestUrl.pathname === '/artifacts/current.json.blockmap';
    const isOldBlockmap =
      request.method === 'GET' &&
      requestUrl.pathname === '/artifacts/old.json.blockmap';
    const isGame =
      ['GET', 'HEAD'].includes(request.method ?? '') &&
      requestUrl.pathname === '/games/golden-journey.txt';
    const isFixtureGameMain =
      ['GET', 'HEAD'].includes(request.method ?? '') &&
      requestUrl.pathname === '/games/fixture-game.cjs';
    const isTorrent =
      request.method === 'GET' &&
      requestUrl.pathname === '/games/golden-journey.torrent' &&
      torrentContents !== undefined;
    const isImage =
      request.method === 'GET' &&
      requestUrl.pathname === '/images/golden-journey.svg';
    const status =
      (isGame || isArtifact) && request.headers.range
        ? 206
        : isArtifact && incrementalUpdate === 'fallback-failure'
          ? 503
          : isReleases ||
              isArtifact ||
              isIncrementalPatch ||
              isOldBlockmap ||
              isGame ||
              isFixtureGameMain ||
              isTorrent ||
              isImage
            ? 200
            : 404;
    appendFileSync(
      requestLogPath,
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        method: request.method ?? 'GET',
        path: requestUrl.pathname,
        status,
        unexpected: status === 404,
        ...(request.headers.range ? { range: request.headers.range } : {}),
      })}\n`
    );
    if (isReleases) {
      const address = server.address();
      if (!address || typeof address === 'string') {
        response.writeHead(500);
        response.end();
        return;
      }
      const baseUrl = `http://127.0.0.1:${address.port}`;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify([
          {
            tag_name: 'v4.1.0-e2e',
            prerelease: false,
            assets: [
              {
                name: 'OpenGameInstaller-e2e.json',
                browser_download_url: `${baseUrl}/artifacts/current.json`,
                size: artifactContents.byteLength,
                digest: artifactDigest,
              },
              ...(incrementalUpdate === 'none'
                ? []
                : [
                    {
                      name: 'OpenGameInstaller-e2e.json.blockmap',
                      browser_download_url: `${baseUrl}/artifacts/current.json.blockmap`,
                    },
                  ]),
            ],
          },
          ...(incrementalUpdate === 'none'
            ? []
            : [
                {
                  tag_name: 'v4.0.0-e2e',
                  prerelease: false,
                  assets: [
                    {
                      name: 'OpenGameInstaller-e2e.json',
                      browser_download_url: `${baseUrl}/artifacts/old.json`,
                      size: oldArtifactContents?.byteLength,
                      digest: oldArtifactDigest,
                    },
                    {
                      name: 'OpenGameInstaller-e2e.json.blockmap',
                      browser_download_url: `${baseUrl}/artifacts/old.json.blockmap`,
                    },
                  ],
                },
              ]),
        ])
      );
      return;
    }
    if (isArtifact) {
      if (incrementalUpdate === 'fallback-failure') {
        response.writeHead(503, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'Full artifact unavailable' }));
        return;
      }
      const range = request.headers.range?.match(/^bytes=(\d+)-(\d+)$/);
      if (range) {
        const start = Number(range[1]);
        const end = Number(range[2]);
        if (
          !Number.isSafeInteger(start) ||
          !Number.isSafeInteger(end) ||
          start < 0 ||
          end < start ||
          end >= artifactContents.byteLength
        ) {
          response.writeHead(416, {
            'content-range': `bytes */${artifactContents.byteLength}`,
          });
          response.end();
          return;
        }
        const body = artifactContents.subarray(start, end + 1);
        response.writeHead(206, {
          'content-type': 'application/json',
          'content-length': body.byteLength,
          'content-range': `bytes ${start}-${end}/${artifactContents.byteLength}`,
          'accept-ranges': 'bytes',
        });
        response.end(body);
        return;
      }
      response.writeHead(200, {
        'content-type': 'application/json',
        'content-length': artifactContents.byteLength,
        'accept-ranges': 'bytes',
      });
      response.end(artifactContents);
      return;
    }
    if (isIncrementalPatch) {
      if (!patchContents) {
        response.writeHead(500);
        response.end();
        return;
      }
      if (incrementalUpdate === 'interrupted') {
        const partial = patchContents.subarray(
          0,
          Math.max(1, Math.floor(patchContents.byteLength / 2))
        );
        response.writeHead(200, {
          'content-type': 'application/json',
          'content-length': partial.byteLength,
        });
        response.end(partial);
        return;
      }
      if (
        incrementalUpdate === 'corrupt' ||
        incrementalUpdate === 'fallback-failure'
      ) {
        const corrupt = JSON.parse(
          gunzipSync(patchContents).toString('utf8')
        ) as { files: Array<{ checksums: string[] }> };
        corrupt.files[0]!.checksums[0] = 'A'.repeat(24);
        const body = gzipSync(JSON.stringify(corrupt));
        response.writeHead(200, {
          'content-type': 'application/json',
          'content-length': body.byteLength,
        });
        response.end(body);
        return;
      }
      response.writeHead(200, {
        'content-type': 'application/json',
        'content-length': patchContents.byteLength,
      });
      response.end(patchContents);
      return;
    }
    if (isOldBlockmap) {
      if (!oldBlockmapContents) {
        response.writeHead(500);
        response.end();
        return;
      }
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': oldBlockmapContents.byteLength,
      });
      response.end(oldBlockmapContents);
      return;
    }
    if (isGame) {
      const range = request.headers.range?.match(/^bytes=(\d+)-$/);
      const startByte = range ? Number(range[1]) : 0;
      if (
        !Number.isInteger(startByte) ||
        startByte < 0 ||
        startByte >= FIXTURE_GAME_CONTENT.byteLength
      ) {
        response.writeHead(416, {
          'content-range': `bytes */${FIXTURE_GAME_CONTENT.byteLength}`,
        });
        response.end();
        return;
      }
      const body = FIXTURE_GAME_CONTENT.subarray(startByte);
      response.writeHead(range ? 206 : 200, {
        'content-type': 'text/plain',
        'content-length': body.byteLength,
        'accept-ranges': 'bytes',
        ...(range
          ? {
              'content-range': `bytes ${startByte}-${FIXTURE_GAME_CONTENT.byteLength - 1}/${FIXTURE_GAME_CONTENT.byteLength}`,
            }
          : {}),
      });
      if (request.method === 'HEAD') {
        response.end();
        return;
      }
      if (range) {
        response.end(body);
        return;
      }

      const terminationStatePath = join(
        fixtureStateDirectory,
        'partial-download-ready.json'
      );
      const chunkSize = 8 * 1024;
      let offset = 0;
      const sendChunk = () => {
        if (response.destroyed) return;
        const nextOffset = Math.min(offset + chunkSize, body.byteLength);
        response.write(body.subarray(offset, nextOffset));
        offset = nextOffset;
        if (
          offset >= FIXTURE_GAME_TERMINATION_BYTES &&
          !existsSync(terminationStatePath)
        ) {
          writeFileSync(
            terminationStatePath,
            JSON.stringify({
              bytesServed: FIXTURE_GAME_TERMINATION_BYTES,
              totalBytes: FIXTURE_GAME_CONTENT.byteLength,
            })
          );
        }
        if (offset >= FIXTURE_GAME_TERMINATION_BYTES) {
          if (!holdGameDownloadAtTerminationPoint) {
            response.end(body.subarray(offset));
          }
          return;
        }
        setTimeout(sendChunk, 100);
      };
      sendChunk();
      return;
    }
    if (isFixtureGameMain) {
      response.writeHead(200, {
        'content-type': 'application/javascript',
        'content-length': Buffer.byteLength(FIXTURE_GAME_MAIN),
      });
      response.end(request.method === 'HEAD' ? undefined : FIXTURE_GAME_MAIN);
      return;
    }
    if (isTorrent && torrentContents) {
      response.writeHead(200, {
        'content-type': 'application/x-bittorrent',
        'content-length': torrentContents.byteLength,
      });
      response.end(torrentContents);
      return;
    }
    if (isImage) {
      const body =
        '<svg xmlns="http://www.w3.org/2000/svg" width="375" height="500"><rect width="100%" height="100%" fill="#6d5dfc"/><text x="50%" y="50%" fill="white" text-anchor="middle">Golden Journey</text></svg>';
      response.writeHead(200, {
        'content-type': 'image/svg+xml',
        'content-length': Buffer.byteLength(body),
      });
      response.end(body);
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({ error: 'Unexpected Fixture Service request' })
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Fixture Service did not allocate a loopback port');
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  let torrent:
    | {
        torrentUrl: string;
        trackerUrl: string;
        trackerAddress: string;
        peerPort: number;
        peerAddress: string;
        payloadManifest: FixturePayloadManifestEntry[];
      }
    | undefined;
  let torrentClient:
    | {
        destroy: (callback: (error?: string | Error) => void) => void;
      }
    | undefined;
  let trackerServer:
    | { close: (callback?: (error?: Error) => void) => void }
    | undefined;

  if (deterministicTorrentInstallation) {
    const trackerModuleSpecifier: string = 'bittorrent-tracker/server';
    const { default: TrackerServer } = await import(trackerModuleSpecifier);
    const tracker = new TrackerServer({
      http: true,
      udp: false,
      ws: false,
      stats: false,
      interval: 1000,
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      tracker.once('error', rejectListen);
      tracker.listen(0, '127.0.0.1', () => {
        tracker.off('error', rejectListen);
        resolveListen();
      });
    });
    const trackerAddress = tracker.http?.address();
    if (!trackerAddress || typeof trackerAddress === 'string') {
      tracker.close();
      server.close();
      throw new Error('Torrent tracker did not allocate a loopback port');
    }
    const trackerUrl = `http://127.0.0.1:${trackerAddress.port}/announce`;
    const payloadDirectory = join(fixtureStateDirectory, 'torrent-payload');
    mkdirSync(payloadDirectory, { recursive: true });
    writeFileSync(
      join(payloadDirectory, 'golden-journey.txt'),
      FIXTURE_GAME_CONTENT
    );
    writeFileSync(
      join(payloadDirectory, 'fixture-game.cjs'),
      FIXTURE_GAME_MAIN
    );

    const { default: WebTorrent } = await import('webtorrent');
    const seeder = new WebTorrent({
      dht: false,
      lsd: false,
      utp: false,
      tracker: true,
      natUpnp: false,
      natPmp: false,
      uploadLimit: 64 * 1024,
    } as ConstructorParameters<typeof WebTorrent>[0]);
    verifyExactFixtureTree(payloadDirectory, FIXTURE_TORRENT_PAYLOAD_MANIFEST);
    const seeded = await new Promise<{ torrentFile: Buffer }>(
      (resolveSeed, rejectSeed) => {
        seeder.once('error', rejectSeed);
        seeder.seed(
          payloadDirectory,
          {
            announce: [trackerUrl],
            private: true,
            name: 'torrent-payload',
          } as never,
          (seededTorrent) => {
            seeder.off('error', rejectSeed);
            if (!seededTorrent.torrentFile) {
              rejectSeed(
                new Error('Torrent fixture did not produce torrent metadata')
              );
              return;
            }
            const metadataManifest = seededTorrent.files
              .map((file) => ({
                relativePath: file.path
                  .replace(/^torrent-payload[\\/]/, '')
                  .replaceAll('\\', '/'),
                size: file.length,
              }))
              .sort((left, right) =>
                left.relativePath.localeCompare(right.relativePath)
              );
            const expectedMetadata = FIXTURE_TORRENT_PAYLOAD_MANIFEST.map(
              ({ relativePath, size }) => ({ relativePath, size })
            );
            if (
              JSON.stringify(metadataManifest) !==
              JSON.stringify(expectedMetadata)
            ) {
              rejectSeed(
                new Error(
                  `Torrent metadata file manifest mismatch: ${JSON.stringify(metadataManifest)}`
                )
              );
              return;
            }
            resolveSeed({
              torrentFile: Buffer.from(seededTorrent.torrentFile),
            });
          }
        );
      }
    );
    torrentContents = seeded.torrentFile;
    const peerListener = (
      seeder as unknown as {
        _connPool?: {
          tcpServer?: {
            address: () =>
              | { address: string; family: string; port: number }
              | string
              | null;
          };
        };
      }
    )._connPool?.tcpServer?.address();
    if (!peerListener || typeof peerListener === 'string') {
      throw new Error('Torrent seeder did not expose its TCP listener');
    }
    torrent = {
      torrentUrl: `${baseUrl}/games/golden-journey.torrent`,
      trackerUrl,
      trackerAddress: trackerAddress.address,
      peerPort: peerListener.port,
      peerAddress: peerListener.address,
      payloadManifest: FIXTURE_TORRENT_PAYLOAD_MANIFEST,
    };
    torrentClient = seeder as unknown as typeof torrentClient;
    trackerServer = tracker;
  }

  return {
    baseUrl,
    requestLogPath,
    torrent,
    close: async () => {
      if (torrentClient) {
        await new Promise<void>((resolveClose, rejectClose) => {
          torrentClient?.destroy((error) =>
            error ? rejectClose(error) : resolveClose()
          );
        });
      }
      if (trackerServer) {
        await new Promise<void>((resolveClose, rejectClose) => {
          trackerServer?.close((error) =>
            error ? rejectClose(error) : resolveClose()
          );
        });
      }
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => (error ? rejectClose(error) : resolveClose()));
      });
    },
  };
}

export type { ProductionPackagingBoundary } from './packaged-handoff-audit';
export {
  assertProductionPackagingBoundary,
  findUnexpectedFixtureRequests,
  findUnexpectedOfflineTraffic,
  findUnexpectedRuntimeLogErrors,
  verifyProductionPackagingBoundary,
} from './packaged-handoff-audit';
