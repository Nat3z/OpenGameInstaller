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
import { getDefaultRunRoot } from './run-reliability';

export type PackagedHandoffPlatform = 'linux' | 'win32';

const fixtureGameLine =
  'OpenGameInstaller interrupted download recovery fixture bytes\n';
export const FIXTURE_GAME_CONTENT = Buffer.from(
  fixtureGameLine.repeat(
    Math.ceil((256 * 1024) / Buffer.byteLength(fixtureGameLine))
  )
).subarray(0, 256 * 1024);
export const FIXTURE_GAME_TERMINATION_BYTES = 64 * 1024;
export const FIXTURE_GAME_MAIN = `const fs = require('node:fs');
const { app, BrowserWindow, ipcMain } = require('electron');
const markerArgument = process.argv.find((argument) => argument.startsWith('--marker='));
if (!markerArgument) throw new Error('Fixture game marker path is required');
const markerPath = markerArgument.slice('--marker='.length);
ipcMain.handle('fixture-game:close', () => app.quit());
app.whenReady().then(() => {
  const window = new BrowserWindow({
    width: 640,
    height: 420,
    show: false,
    title: 'OpenGameInstaller Fixture Game',
    webPreferences: { contextIsolation: false, nodeIntegration: true },
  });
  window.once('ready-to-show', () => {
    window.show();
    fs.writeFileSync(markerPath, JSON.stringify({
      version: 1,
      pid: process.pid,
      platform: process.platform,
      title: 'OpenGameInstaller Fixture Game',
      visible: window.isVisible(),
    }, null, 2));
  });
  return window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
    '<!doctype html><html><head><title>OpenGameInstaller Fixture Game</title></head>' +
    '<body style="font-family:sans-serif;display:grid;place-items:center;height:100vh;margin:0">' +
    '<main><h1>Golden Journey Fixture</h1><p>The fixture game is running.</p>' +
    '<button aria-label="Close Fixture Game" onclick="require(&quot;electron&quot;).ipcRenderer.invoke(&quot;fixture-game:close&quot;)">Close Game</button>' +
    '</main></body></html>'
  ));
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
app.on('window-all-closed', () => app.quit());
`;

export type FixturePayloadManifestEntry = {
  relativePath: string;
  size: number;
  sha256: string;
};

function fixturePayloadEntry(
  relativePath: string,
  contents: Buffer | string
): FixturePayloadManifestEntry {
  const bytes = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
  return {
    relativePath,
    size: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

export const FIXTURE_TORRENT_PAYLOAD_MANIFEST = [
  fixturePayloadEntry('fixture-game.cjs', FIXTURE_GAME_MAIN),
  fixturePayloadEntry('golden-journey.txt', FIXTURE_GAME_CONTENT),
] satisfies FixturePayloadManifestEntry[];

export function verifyExactFixtureTree(
  root: string,
  manifest: readonly FixturePayloadManifestEntry[]
) {
  const actualPaths: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile()) {
        actualPaths.push(relative(root, path).replaceAll('\\', '/'));
      } else {
        throw new Error(`Fixture tree contains unsupported entry: ${path}`);
      }
    }
  };
  visit(root);
  actualPaths.sort();
  const expectedPaths = manifest.map((entry) => entry.relativePath).sort();
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    throw new Error(
      `Fixture file set mismatch: expected ${JSON.stringify(expectedPaths)}, received ${JSON.stringify(actualPaths)}`
    );
  }
  for (const entry of manifest) {
    const path = join(root, entry.relativePath);
    const bytes = readFileSync(path);
    if (bytes.byteLength !== entry.size) {
      throw new Error(
        `${entry.relativePath} size mismatch: expected ${entry.size}, received ${bytes.byteLength}`
      );
    }
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== entry.sha256) {
      throw new Error(`${entry.relativePath} SHA-256 mismatch`);
    }
  }
  return manifest;
}

export type TorrentLibraryRecord = {
  cwd: string;
  installDirectory: string;
  launchExecutable: string;
  version: '1.0.0';
  installRoot: string;
  capsuleImage: string;
  coverImage: string;
  name: 'Golden Journey Fixture';
  appID: 7001;
  storefront: 'ogi-e2e';
  addonsource: 'ogi-e2e-fixture-addon';
};

const TORRENT_LIBRARY_RECORD_KEYS = [
  'cwd',
  'installDirectory',
  'launchExecutable',
  'version',
  'installRoot',
  'capsuleImage',
  'coverImage',
  'name',
  'appID',
  'storefront',
  'addonsource',
] as const;

export function verifyExactTorrentLibraryState(options: {
  sandboxDirectory: string;
  libraryDirectory: string;
  expectedInstallRoot: string;
  fixtureBaseUrl: string;
  visibleItems: readonly {
    text: string;
    imageAlts: readonly string[];
  }[];
  launcherName: string;
}) {
  if (options.visibleItems.length !== 1) {
    throw new Error(
      `Expected exactly one visible Library item, received ${options.visibleItems.length}`
    );
  }
  const [visibleItem] = options.visibleItems;
  if (
    !visibleItem ||
    (!visibleItem.text.includes('Golden Journey Fixture') &&
      !visibleItem.imageAlts.includes('Golden Journey Fixture'))
  ) {
    throw new Error('Visible Library item is not Golden Journey Fixture');
  }

  const libraryEntries = readdirSync(options.libraryDirectory, {
    withFileTypes: true,
  });
  if (libraryEntries.length !== 1) {
    throw new Error(
      `Expected exactly one Library record, received ${libraryEntries.length}`
    );
  }
  const [libraryEntry] = libraryEntries;
  if (!libraryEntry?.isFile() || libraryEntry.name !== '7001.json') {
    throw new Error('Expected the only Library record to be 7001.json');
  }
  const libraryPath = join(options.libraryDirectory, libraryEntry.name);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(libraryPath, 'utf8'));
  } catch {
    throw new Error('Torrent-installed Library record is malformed');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Torrent-installed Library record is malformed');
  }
  const actualKeys = Object.keys(parsed).sort();
  const expectedKeys = [...TORRENT_LIBRARY_RECORD_KEYS].sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    throw new Error(
      `Torrent-installed Library record has unknown or missing fields: expected ${JSON.stringify(expectedKeys)}, received ${JSON.stringify(actualKeys)}`
    );
  }

  const library = parsed as Partial<TorrentLibraryRecord>;
  const sandboxDirectory = resolve(options.sandboxDirectory);
  const installRoot = resolve(options.expectedInstallRoot);
  const sandboxInstallRoot = join(sandboxDirectory, 'downloads');
  const installRootFromSandbox = relative(sandboxDirectory, installRoot);
  if (
    installRoot !== sandboxInstallRoot ||
    installRootFromSandbox === '' ||
    installRootFromSandbox === '..' ||
    installRootFromSandbox.startsWith(`..${sep}`) ||
    isAbsolute(installRootFromSandbox)
  ) {
    throw new Error(
      'Expected torrent install root is not the sandbox-contained downloads directory'
    );
  }
  const installDirectory = join(
    installRoot,
    'Golden Journey Fixture',
    'installed'
  );
  const launchExecutable = join(installDirectory, options.launcherName);
  let fixtureUrl: URL;
  try {
    fixtureUrl = new URL(options.fixtureBaseUrl);
  } catch {
    throw new Error('Torrent Fixture Service URL is invalid');
  }
  if (
    fixtureUrl.protocol !== 'http:' ||
    fixtureUrl.hostname !== '127.0.0.1' ||
    !fixtureUrl.port ||
    fixtureUrl.pathname !== '/' ||
    fixtureUrl.username ||
    fixtureUrl.password ||
    fixtureUrl.search ||
    fixtureUrl.hash
  ) {
    throw new Error(
      'Torrent Fixture Service URL must be an exact loopback HTTP origin'
    );
  }
  const expectedImageUrl = new URL('/images/golden-journey.svg', fixtureUrl)
    .href;
  if (
    library.cwd !== installDirectory ||
    library.installDirectory !== installDirectory ||
    library.launchExecutable !== launchExecutable ||
    library.version !== '1.0.0' ||
    library.installRoot !== installRoot ||
    library.capsuleImage !== expectedImageUrl ||
    library.coverImage !== expectedImageUrl ||
    library.name !== 'Golden Journey Fixture' ||
    library.appID !== 7001 ||
    library.storefront !== 'ogi-e2e' ||
    library.addonsource !== 'ogi-e2e-fixture-addon'
  ) {
    throw new Error('Torrent-installed Library record is invalid');
  }
  return {
    library: library as TorrentLibraryRecord,
    libraryPath,
    visibleLibraryItems: options.visibleItems.length,
    libraryRecords: libraryEntries.length,
  };
}

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

type PackagedHandoffArtifactInput = {
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

type PackagedHandoffDescriptorWithPath = PackagedHandoffRunDescriptor & {
  descriptorPath: string;
};

export type PackagedApplicationLaunch = {
  entryPoint: string;
  args: string[];
  environment: { OGI_RUN_DESCRIPTOR: string };
};

type StartupHealth = {
  version: 1;
  runId: string;
  state: 'interactive';
};

type ArtifactFile = {
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

function collectArtifactFiles(root: string, destinationRoot: string) {
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

function artifactFile(sourcePath: string, destinationPath: string) {
  return {
    path: destinationPath,
    mode: statSync(sourcePath).mode & 0o777,
    contents: readFileSync(sourcePath).toString('base64'),
  };
}

function launcherName(platform: PackagedHandoffPlatform) {
  return platform === 'win32'
    ? 'OpenGameInstaller.exe'
    : 'OpenGameInstaller.AppImage';
}

function lastKnownGoodLauncherName(platform: PackagedHandoffPlatform) {
  return launcherName(platform);
}

function fixtureBlockmap(contents: Buffer, sizes: number[]) {
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

function compatibleBlockSizes(base: Buffer, target: Buffer) {
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
      join(packagedUpdaterDirectory, 'support/updater-offline-decision.mjs')
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
        'support/application-online-state.mjs'
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
    'support/application-online-state.mjs',
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
      request.method === 'GET' &&
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
      response.end(FIXTURE_GAME_MAIN);
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

export function findUnexpectedOfflineTraffic(
  trafficLogPaths: readonly string[],
  fixtureRequestLogPath: string
) {
  const unexpectedTraffic = trafficLogPaths.flatMap((path) => {
    if (!existsSync(path)) {
      return [{ source: path, expected: false, error: 'traffic log missing' }];
    }
    return readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { expected?: boolean })
      .filter((entry) => entry.expected !== true)
      .map((entry) => ({ source: path, ...entry }));
  });
  if (!existsSync(fixtureRequestLogPath)) {
    return [
      ...unexpectedTraffic,
      {
        source: fixtureRequestLogPath,
        expected: false,
        error: 'Fixture Service request log missing',
      },
    ];
  }
  const unexpectedFixtureRequests = readFileSync(fixtureRequestLogPath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { unexpected?: boolean })
    .filter((entry) => entry.unexpected === true)
    .map((entry) => ({ source: fixtureRequestLogPath, ...entry }));
  return [...unexpectedTraffic, ...unexpectedFixtureRequests];
}

const unexpectedRuntimeErrorPatterns = [
  /UnhandledPromiseRejection/i,
  /Uncaught Exception/i,
  /ERR_UNHANDLED_REJECTION/i,
  /\bFATAL\b/i,
];

export function findUnexpectedRuntimeLogErrors(logPaths: readonly string[]) {
  return logPaths.flatMap((path) => {
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .filter((line) =>
        unexpectedRuntimeErrorPatterns.some((pattern) => pattern.test(line))
      )
      .map((line) => ({ path, line }));
  });
}

export type ProductionPackagingBoundary = {
  applicationIncludedPaths: string[];
  updaterIncludedPaths: string[];
  activeHookMatches: string[];
};

export function assertProductionPackagingBoundary(
  boundary: ProductionPackagingBoundary
) {
  if (boundary.activeHookMatches.length > 0) {
    throw new Error(
      `Production packaging contains active E2E hooks: ${boundary.activeHookMatches.join(', ')}`
    );
  }
  return boundary;
}

export function verifyProductionPackagingBoundary(repositoryDirectory: string) {
  const applicationPackage = JSON.parse(
    readFileSync(join(repositoryDirectory, 'application/package.json'), 'utf8')
  ) as { build?: { files?: string[] } };
  const updaterPackage = JSON.parse(
    readFileSync(join(repositoryDirectory, 'updater/package.json'), 'utf8')
  ) as { build?: { files?: string[] } };
  const applicationIncludedPaths = applicationPackage.build?.files ?? [];
  const updaterIncludedPaths = updaterPackage.build?.files ?? [];
  for (const includedPath of [
    ...applicationIncludedPaths,
    ...updaterIncludedPaths,
  ]) {
    if (/e2e|run-descriptor/i.test(includedPath)) {
      throw new Error(
        `Production packaging includes an E2E path: ${includedPath}`
      );
    }
  }

  const activeHookMatches: string[] = [];
  const scan = (root: string) => {
    if (!existsSync(root)) {
      throw new Error(`Production packaging input is missing: ${root}`);
    }
    const visit = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          visit(path);
          continue;
        }
        if (entry.name.endsWith('.map')) continue;
        const contents = readFileSync(path);
        if (
          contents.includes(Buffer.from('OGI_RUN_DESCRIPTOR')) ||
          contents.includes(Buffer.from('packaged-updater-application-handoff'))
        ) {
          activeHookMatches.push(relative(repositoryDirectory, path));
        }
      }
    };
    visit(root);
  };
  scan(join(repositoryDirectory, 'application/out'));
  scan(join(repositoryDirectory, 'updater/dist'));
  return {
    applicationIncludedPaths,
    updaterIncludedPaths,
    activeHookMatches,
  };
}
