import { afterAll, describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { deleteOwnedInstallDirectory } from '../../application/src/electron/handlers/helpers.app/uninstall';
import {
  assertProductionPackagingBoundary,
  buildPackagedHandoffArtifacts,
  copySyntheticOldInstallation,
  createPackagedHandoffSandbox as createSandbox,
  FIXTURE_GAME_CONTENT,
  FIXTURE_GAME_MAIN,
  FIXTURE_GAME_TERMINATION_BYTES,
  FIXTURE_TORRENT_PAYLOAD_MANIFEST,
  findUnexpectedOfflineTraffic,
  findUnexpectedRuntimeLogErrors,
  installPackagedApplicationArtifact,
  parsePackagedHandoffRunDescriptor,
  performRecoverableHandoff,
  seedOfflineFixtureGame,
  startPackagedHandoffFixture,
  type TorrentLibraryRecord,
  verifyExactFixtureTree,
  verifyExactTorrentLibraryState,
  verifyProductionPackagingBoundary,
  writePackagedHandoffRunDescriptor,
} from '../src/packaged-handoff';

const generatedSandboxes: string[] = [];
const createPackagedHandoffSandbox: typeof createSandbox = (...args) => {
  const sandbox = createSandbox(...args);
  generatedSandboxes.push(sandbox.sandboxDirectory);
  return sandbox;
};
afterAll(() => {
  for (const sandbox of generatedSandboxes) {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

const require = createRequire(import.meta.url);
const { applyIncrementalPatch, createIncrementalPatch } =
  require('../incremental-update.cjs') as {
    applyIncrementalPatch(base: Buffer, patch: unknown): Buffer;
    createIncrementalPatch(
      base: Buffer,
      target: Buffer,
      versions: {
        fromVersion: string;
        toVersion: string;
      }
    ): Record<string, unknown>;
  };
const { registerFixtureService } = require('../fixture-service.cjs') as {
  registerFixtureService(
    ipcMain: unknown,
    applicationStateDirectory: string,
    fixtureBaseUrl: string,
    scenarioSandboxDirectory: string,
    clientSdkPort: number,
    effectiveOnline: boolean
  ): (() => Promise<void>) & { ready: Promise<void> };
};
const { classifyUrl, requestUrl } = require('../offline-traffic-guard.cjs') as {
  classifyUrl(
    url: string,
    expectedEndpoints?: Array<{ host: string; port: number }>
  ): 'expected' | 'unexpected' | 'ignored';
  requestUrl(
    protocol: 'http:' | 'https:',
    input: unknown,
    options?: unknown
  ): string | null;
};

function createHandoffTestBuild(runId: string) {
  const source = mkdtempSync(join(tmpdir(), `ogi-handoff-${runId}-`));
  const bundle = join(source, 'bundle');
  mkdirSync(join(bundle, 'renderer'), { recursive: true });
  mkdirSync(join(bundle, 'preload'), { recursive: true });
  writeFileSync(join(bundle, 'renderer', 'index.html'), '<h1>Current</h1>');
  writeFileSync(join(bundle, 'preload', 'index.mjs'), '// preload\n');
  for (const name of [
    'e2e-product-main.cjs',
    'e2e-product-updater-main.cjs',
    'fixture-service.cjs',
    'offline-traffic-guard.cjs',
    'application-online-state.mjs',
    'updater-offline-decision.mjs',
    'packaged-handoff-run-descriptor.cjs',
  ]) {
    writeFileSync(join(source, name), `// ${name}\n`);
  }
  const [build] = buildPackagedHandoffArtifacts({
    outputDirectory: join(source, 'builds'),
    applicationBundleDirectory: bundle,
    applicationMainPath: join(source, 'e2e-product-main.cjs'),
    applicationOnlineStatePath: join(source, 'application-online-state.mjs'),
    fixtureServicePath: join(source, 'fixture-service.cjs'),
    trafficGuardPath: join(source, 'offline-traffic-guard.cjs'),
    descriptorValidatorPath: join(
      source,
      'packaged-handoff-run-descriptor.cjs'
    ),
    updaterBundleDirectory: bundle,
    updaterPublicDirectory: bundle,
    updaterMainPath: join(source, 'e2e-product-updater-main.cjs'),
    updaterOfflineDecisionPath: join(source, 'updater-offline-decision.mjs'),
    fixtureAddonDirectory: bundle,
    fixtureWebSocketModuleDirectory: bundle,
    updaterUpdateEnginePath: join(
      import.meta.dir,
      '../../updater/src/update-engine.mjs'
    ),
  });
  if (!build) throw new Error('Linux handoff build was not created');
  const descriptor = createPackagedHandoffSandbox(runId, 'linux');
  copySyntheticOldInstallation(
    build.syntheticOldInstallationDirectory,
    descriptor.installationDirectory
  );
  return { source, build, descriptor };
}

function expectLastKnownGoodInstallation(installationDirectory: string) {
  expect(readFileSync(join(installationDirectory, 'version.txt'), 'utf8')).toBe(
    'v0.0.1-e2e'
  );
  expect(
    existsSync(join(installationDirectory, 'OpenGameInstaller.AppImage'))
  ).toBe(true);
}

describe('packaged updater-to-application handoff', () => {
  test('rejects missing, extra, truncated, and substituted torrent payload files', () => {
    const root = mkdtempSync(join(tmpdir(), 'ogi-torrent-manifest-test-'));
    generatedSandboxes.push(root);
    const writeValidTree = () => {
      rmSync(root, { recursive: true, force: true });
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, 'fixture-game.cjs'), FIXTURE_GAME_MAIN);
      writeFileSync(join(root, 'golden-journey.txt'), FIXTURE_GAME_CONTENT);
    };

    writeValidTree();
    rmSync(join(root, 'golden-journey.txt'));
    expect(() =>
      verifyExactFixtureTree(root, FIXTURE_TORRENT_PAYLOAD_MANIFEST)
    ).toThrow('Fixture file set mismatch');

    writeValidTree();
    writeFileSync(join(root, 'unexpected.txt'), 'unexpected');
    expect(() =>
      verifyExactFixtureTree(root, FIXTURE_TORRENT_PAYLOAD_MANIFEST)
    ).toThrow('Fixture file set mismatch');

    writeValidTree();
    writeFileSync(
      join(root, 'golden-journey.txt'),
      FIXTURE_GAME_CONTENT.subarray(0, FIXTURE_GAME_CONTENT.byteLength - 1)
    );
    expect(() =>
      verifyExactFixtureTree(root, FIXTURE_TORRENT_PAYLOAD_MANIFEST)
    ).toThrow('golden-journey.txt size mismatch');

    writeValidTree();
    const substitutedSecondFile = Buffer.from(FIXTURE_GAME_CONTENT);
    substitutedSecondFile[1] ^= 0xff;
    writeFileSync(join(root, 'golden-journey.txt'), substitutedSecondFile);
    expect(() =>
      verifyExactFixtureTree(root, FIXTURE_TORRENT_PAYLOAD_MANIFEST)
    ).toThrow('golden-journey.txt SHA-256 mismatch');
  });

  test('rejects incomplete or semantically corrupt persisted torrent Library state', () => {
    const root = mkdtempSync(join(tmpdir(), 'ogi-torrent-library-test-'));
    generatedSandboxes.push(root);
    const libraryDirectory = join(root, 'library');
    const installRoot = join(root, 'downloads');
    const installDirectory = join(
      installRoot,
      'Golden Journey Fixture',
      'installed'
    );
    const fixtureBaseUrl = 'http://127.0.0.1:45678';
    const expectedRecord = {
      cwd: installDirectory,
      installDirectory,
      launchExecutable: join(installDirectory, 'fixture-game.sh'),
      version: '1.0.0',
      installRoot,
      capsuleImage: `${fixtureBaseUrl}/images/golden-journey.svg`,
      coverImage: `${fixtureBaseUrl}/images/golden-journey.svg`,
      name: 'Golden Journey Fixture',
      appID: 7001,
      storefront: 'ogi-e2e',
      addonsource: 'ogi-e2e-fixture-addon',
    } satisfies TorrentLibraryRecord;
    const expectedCard = {
      text: 'Golden Journey Fixture',
      imageAlts: ['Golden Journey Fixture'],
    };
    const writeRecord = (record: Record<string, unknown> = expectedRecord) => {
      rmSync(libraryDirectory, { recursive: true, force: true });
      mkdirSync(libraryDirectory, { recursive: true });
      writeFileSync(
        join(libraryDirectory, '7001.json'),
        JSON.stringify(record)
      );
    };
    const verifyRecord = (visibleItems = [expectedCard]) =>
      verifyExactTorrentLibraryState({
        sandboxDirectory: root,
        libraryDirectory,
        expectedInstallRoot: installRoot,
        fixtureBaseUrl,
        visibleItems,
        launcherName: 'fixture-game.sh',
      });

    writeRecord();
    expect(verifyRecord().library).toEqual(expectedRecord);

    for (const field of Object.keys(expectedRecord)) {
      const incomplete = { ...expectedRecord } as Record<string, unknown>;
      delete incomplete[field];
      writeRecord(incomplete);
      expect(() => verifyRecord()).toThrow();
    }

    const corruptions: Array<[string, Record<string, unknown>]> = [
      ['cwd', { cwd: resolve(root, '../escaped-cwd') }],
      [
        'installDirectory',
        { installDirectory: resolve(root, '../escaped-install') },
      ],
      [
        'launchExecutable',
        { launchExecutable: resolve(root, '../escaped-launcher') },
      ],
      ['version', { version: '9.9.9' }],
      ['installRoot', { installRoot: resolve(root, '../escaped-root') }],
      ['capsuleImage', { capsuleImage: 'https://public.example/game.svg' }],
      ['coverImage', { coverImage: `${fixtureBaseUrl}/images/wrong.svg` }],
      ['name', { name: 'Wrong Fixture' }],
      ['appID', { appID: 7002 }],
      ['storefront', { storefront: 'wrong-storefront' }],
      ['addonsource', { addonsource: 'wrong-addon' }],
    ];
    for (const [_field, corruption] of corruptions) {
      writeRecord({ ...expectedRecord, ...corruption });
      expect(() => verifyRecord()).toThrow();
    }

    writeRecord({ ...expectedRecord, unknownField: true });
    expect(() => verifyRecord()).toThrow('unknown or missing fields');

    writeRecord();
    expect(() =>
      verifyRecord([expectedCard, { text: 'Hidden Extra Game', imageAlts: [] }])
    ).toThrow('exactly one visible Library item');

    writeRecord();
    writeFileSync(
      join(libraryDirectory, '9999.json'),
      JSON.stringify(expectedRecord)
    );
    expect(() => verifyRecord()).toThrow('exactly one Library record');

    writeRecord();
    writeFileSync(join(libraryDirectory, '.hidden.json'), '{}');
    expect(() => verifyRecord()).toThrow('exactly one Library record');

    writeRecord();
    writeFileSync(join(libraryDirectory, '7001.json'), '{malformed');
    expect(() => verifyRecord()).toThrow('Library record is malformed');
  });

  test('creates one strict Run Descriptor inside a fresh Scenario Sandbox', () => {
    const descriptor = createPackagedHandoffSandbox(
      'packaged-handoff-descriptor',
      'linux'
    );

    expect(existsSync(descriptor.descriptorPath)).toBe(true);
    expect(descriptor.scenario).toBe('packaged-updater-application-handoff');
    expect(descriptor.platform).toBe('linux');
    expect(descriptor.updaterUserDataDirectory).not.toBe(
      descriptor.applicationUserDataDirectory
    );
    expect(
      descriptor.startupHealthPath.startsWith(descriptor.sandboxDirectory)
    ).toBe(true);
    expect(
      descriptor.backupDirectory.startsWith(descriptor.sandboxDirectory)
    ).toBe(true);
    expect(descriptor.incrementalUpdate).toBe('none');
    const { descriptorPath: _descriptorPath, ...runDescriptor } = descriptor;
    expect(() =>
      parsePackagedHandoffRunDescriptor({
        ...runDescriptor,
        unexpectedHook: true,
      })
    ).toThrow('unknown fields');
    expect(() =>
      parsePackagedHandoffRunDescriptor({
        ...runDescriptor,
        installationDirectory: '/tmp/real-installation',
      })
    ).toThrow('escapes the Scenario Sandbox');
    expect(() =>
      parsePackagedHandoffRunDescriptor({
        ...runDescriptor,
        incrementalUpdate: 'unknown',
      })
    ).toThrow('incrementalUpdate is invalid');
    expect(() =>
      parsePackagedHandoffRunDescriptor({
        ...runDescriptor,
        deterministicTorrentInstallation: true,
        torrentUrl: 'https://public.example/game.torrent',
        torrentTrackerUrl: 'http://127.0.0.1:6969/announce',
        torrentPeerPort: 51413,
      })
    ).toThrow('torrentUrl must use loopback HTTP');
    expect(() =>
      parsePackagedHandoffRunDescriptor({
        ...runDescriptor,
        torrentUrl: `${runDescriptor.fixtureBaseUrl}/game.torrent`,
      })
    ).toThrow('torrent fixture fields require');

    const windowsDescriptor = createPackagedHandoffSandbox(
      'packaged-handoff-torrent-windows',
      'win32'
    );
    const windowsTorrent = writePackagedHandoffRunDescriptor(
      windowsDescriptor,
      'http://127.0.0.1:41000',
      41001,
      41002,
      41003,
      'none',
      false,
      false,
      false,
      'none',
      true,
      {
        torrentUrl: 'http://127.0.0.1:41000/games/fixture.torrent',
        trackerUrl: 'http://127.0.0.1:41004/announce',
        peerPort: 41005,
      }
    );
    expect(windowsTorrent.applicationLauncherPath).toEndWith(
      'OpenGameInstaller.exe'
    );
    expect(windowsTorrent.deterministicTorrentInstallation).toBe(true);
    const windowsIsolationScript = readFileSync(
      join(import.meta.dir, '../src/windows-torrent-network-isolation.ps1'),
      'utf8'
    );
    expect(windowsIsolationScript).toContain('New-NetFirewallRule');
    expect(windowsIsolationScript).toContain("@('Inbound', 'Outbound')");
    expect(windowsIsolationScript).toContain('-Direction $direction');
    expect(windowsIsolationScript).toContain('-RemoteAddress Any');
    expect(windowsIsolationScript).toContain('Remove-NetFirewallRule');
    expect(windowsIsolationScript).toMatch(/try\s*\{/);
    expect(windowsIsolationScript).toMatch(/finally\s*\{/);
    const reliableRunner = readFileSync(
      join(import.meta.dir, '../src/run-reliable-packaged-handoff.ts'),
      'utf8'
    );
    expect(reliableRunner).toContain("'--unshare-net'");
    expect(reliableRunner).toContain('windows-torrent-network-isolation.ps1');
  });

  test('builds synthetic old installations and packaged current applications for Linux and Windows', () => {
    const source = mkdtempSync(join(tmpdir(), 'ogi-handoff-builder-source-'));
    const bundle = join(source, 'bundle');
    mkdirSync(join(bundle, 'renderer'), { recursive: true });
    writeFileSync(join(bundle, 'renderer', 'index.html'), '<h1>Current</h1>');
    for (const name of [
      'e2e-product-main.cjs',
      'e2e-product-updater-main.cjs',
      'fixture-service.cjs',
      'offline-traffic-guard.cjs',
      'application-online-state.mjs',
      'updater-offline-decision.mjs',
      'packaged-handoff-run-descriptor.cjs',
    ]) {
      writeFileSync(join(source, name), `// ${name}\n`);
    }
    const updaterBundle = join(source, 'updater-dist');
    const updaterPublic = join(source, 'updater-public');
    mkdirSync(updaterBundle);
    mkdirSync(updaterPublic);
    writeFileSync(join(updaterBundle, 'preload.js'), '// preload\n');
    writeFileSync(join(updaterPublic, 'index.html'), '<h1>Updater</h1>');
    const fixtureAddon = join(source, 'fixture-addon');
    mkdirSync(join(fixtureAddon, 'dist'), { recursive: true });
    writeFileSync(join(fixtureAddon, 'addon.json'), '{"scripts":{}}');
    writeFileSync(join(fixtureAddon, 'main.js'), '// fixture addon\n');
    writeFileSync(
      join(fixtureAddon, 'dist/torrent-runtime.mjs'),
      '// production torrent runtime\n'
    );
    const fixtureWebSocketModule = join(source, 'ws');
    mkdirSync(fixtureWebSocketModule);
    writeFileSync(join(fixtureWebSocketModule, 'index.js'), '// ws\n');
    const output = join(source, 'builds');

    const builds = buildPackagedHandoffArtifacts({
      outputDirectory: output,
      applicationBundleDirectory: bundle,
      applicationMainPath: join(source, 'e2e-product-main.cjs'),
      applicationOnlineStatePath: join(source, 'application-online-state.mjs'),
      fixtureServicePath: join(source, 'fixture-service.cjs'),
      trafficGuardPath: join(source, 'offline-traffic-guard.cjs'),
      descriptorValidatorPath: join(
        source,
        'packaged-handoff-run-descriptor.cjs'
      ),
      updaterBundleDirectory: updaterBundle,
      updaterPublicDirectory: updaterPublic,
      updaterMainPath: join(source, 'e2e-product-updater-main.cjs'),
      updaterOfflineDecisionPath: join(source, 'updater-offline-decision.mjs'),
      fixtureAddonDirectory: fixtureAddon,
      fixtureWebSocketModuleDirectory: fixtureWebSocketModule,
      updaterUpdateEnginePath: join(
        import.meta.dir,
        '../../updater/src/update-engine.mjs'
      ),
    });

    expect(builds.map((build) => build.platform)).toEqual(['linux', 'win32']);
    for (const build of builds) {
      expect(existsSync(build.syntheticOldInstallationDirectory)).toBe(true);
      expect(
        existsSync(join(build.packagedUpdaterDirectory, 'dist/preload.js'))
      ).toBe(true);
      expect(
        existsSync(join(build.packagedUpdaterDirectory, 'e2e-product-main.cjs'))
      ).toBe(true);
      expect(
        existsSync(
          join(build.packagedUpdaterDirectory, 'support/update-engine.mjs')
        )
      ).toBe(true);
      expect(
        readFileSync(
          join(
            build.packagedUpdaterDirectory,
            'support/production-update-coordinator.mjs'
          )
        )
      ).toEqual(
        readFileSync(
          join(
            import.meta.dir,
            '../../updater/src/production-update-coordinator.mjs'
          )
        )
      );
      expect(
        JSON.parse(
          readFileSync(
            join(build.packagedUpdaterDirectory, 'package.json'),
            'utf8'
          )
        )
      ).toEqual({ type: 'module' });
      expect(
        readFileSync(
          join(build.syntheticOldInstallationDirectory, 'version.txt'),
          'utf8'
        )
      ).toBe('v0.0.1-e2e');
      expect(
        existsSync(
          join(
            build.syntheticOldInstallationDirectory,
            build.platform === 'win32'
              ? 'OpenGameInstaller.exe'
              : 'OpenGameInstaller.AppImage'
          )
        )
      ).toBe(true);
      expect(
        existsSync(
          join(
            build.syntheticOldInstallationDirectory,
            'app/e2e-product-main.cjs'
          )
        )
      ).toBe(true);
      expect(
        readFileSync(
          join(build.incrementalOldInstallationDirectory, 'version.txt'),
          'utf8'
        )
      ).toBe('v4.0.0-e2e');
      expect(
        readFileSync(
          join(
            build.incrementalOldInstallationDirectory,
            'source-artifact.json'
          )
        )
      ).toEqual(readFileSync(build.incrementalOldApplicationArtifactPath));
      expect(existsSync(build.incrementalOldBlockmapPath)).toBe(true);
      expect(existsSync(build.incrementalPatchPath)).toBe(true);
      const artifact = JSON.parse(
        readFileSync(build.currentApplicationArtifactPath, 'utf8')
      );
      expect(artifact).toEqual(
        expect.objectContaining({
          formatVersion: 1,
          platform: build.platform,
          version: 'v4.1.0-e2e',
          entryPoint: 'app/e2e-product-main.cjs',
        })
      );
      expect(artifact.files.map((file: { path: string }) => file.path)).toEqual(
        expect.arrayContaining([
          'app/e2e-product-main.cjs',
          'app/out/renderer/index.html',
          'app/ogi-e2e-fixture-addon/addon.json',
          'app/ogi-e2e-fixture-addon/main.js',
          'app/ogi-e2e-fixture-addon/dist/torrent-runtime.mjs',
          'support/fixture-service.cjs',
          'support/packaged-handoff-run-descriptor.cjs',
        ])
      );
    }
  });

  test('builds compatible old/current artifacts and deterministic incremental metadata', () => {
    const { source, build } = createHandoffTestBuild('incremental-artifacts');

    try {
      expect(existsSync(build.incrementalOldApplicationArtifactPath)).toBe(
        true
      );
      expect(existsSync(build.incrementalPatchPath)).toBe(true);
      expect(existsSync(build.incrementalOldInstallationDirectory)).toBe(true);
      expect(
        readFileSync(
          join(build.incrementalOldInstallationDirectory, 'version.txt'),
          'utf8'
        )
      ).toBe('v4.0.0-e2e');
      const oldBlockmap = JSON.parse(
        gunzipSync(readFileSync(build.incrementalOldBlockmapPath)).toString(
          'utf8'
        )
      );
      const currentBlockmap = JSON.parse(
        gunzipSync(readFileSync(build.incrementalPatchPath)).toString('utf8')
      );
      expect(oldBlockmap).toMatchObject({ version: '2' });
      expect(currentBlockmap).toMatchObject({ version: '2' });
      expect(oldBlockmap.files[0].checksums.length).toBeGreaterThan(1);
      expect(currentBlockmap.files[0].checksums.length).toBeGreaterThan(1);
    } finally {
      rmSync(source, { recursive: true, force: true });
    }
  });

  test('rejects corrupt or interrupted incremental patches before replacement', () => {
    const base = Buffer.from('compatible-old-artifact');
    const target = Buffer.from('compatible-current-artifact');
    const patch = createIncrementalPatch(base, target, {
      fromVersion: 'v4.0.0-e2e',
      toVersion: 'v4.1.0-e2e',
    });

    expect(() =>
      applyIncrementalPatch(base, { ...patch, targetSha256: '0'.repeat(64) })
    ).toThrow('target checksum');
    expect(() =>
      applyIncrementalPatch(
        base,
        JSON.parse(JSON.stringify(patch).slice(0, -10))
      )
    ).toThrow();
  });

  test('forwards only the Run Descriptor and retains Last Known-Good until Startup Health', async () => {
    const source = mkdtempSync(join(tmpdir(), 'ogi-handoff-health-source-'));
    const bundle = join(source, 'bundle');
    mkdirSync(join(bundle, 'renderer'), { recursive: true });
    mkdirSync(join(bundle, 'preload'), { recursive: true });
    writeFileSync(join(bundle, 'renderer', 'index.html'), '<h1>Current</h1>');
    writeFileSync(join(bundle, 'preload', 'index.mjs'), '// preload\n');
    for (const name of [
      'e2e-product-main.cjs',
      'e2e-product-updater-main.cjs',
      'fixture-service.cjs',
      'offline-traffic-guard.cjs',
      'application-online-state.mjs',
      'updater-offline-decision.mjs',
      'packaged-handoff-run-descriptor.cjs',
    ]) {
      writeFileSync(join(source, name), `// ${name}\n`);
    }
    const [linuxBuild] = buildPackagedHandoffArtifacts({
      outputDirectory: join(source, 'builds'),
      applicationBundleDirectory: bundle,
      applicationMainPath: join(source, 'e2e-product-main.cjs'),
      applicationOnlineStatePath: join(source, 'application-online-state.mjs'),
      fixtureServicePath: join(source, 'fixture-service.cjs'),
      trafficGuardPath: join(source, 'offline-traffic-guard.cjs'),
      descriptorValidatorPath: join(
        source,
        'packaged-handoff-run-descriptor.cjs'
      ),
      updaterBundleDirectory: bundle,
      updaterPublicDirectory: bundle,
      updaterMainPath: join(source, 'e2e-product-updater-main.cjs'),
      updaterOfflineDecisionPath: join(source, 'updater-offline-decision.mjs'),
      fixtureAddonDirectory: bundle,
      fixtureWebSocketModuleDirectory: bundle,
      updaterUpdateEnginePath: join(
        import.meta.dir,
        '../../updater/src/update-engine.mjs'
      ),
    });
    const descriptor = createPackagedHandoffSandbox(
      'last-known-good-health',
      'linux'
    );
    copySyntheticOldInstallation(
      linuxBuild!.syntheticOldInstallationDirectory,
      descriptor.installationDirectory
    );

    const result = await performRecoverableHandoff({
      descriptor,
      currentApplicationArtifactPath:
        linuxBuild!.currentApplicationArtifactPath,
      launchApplication: async (launch) => {
        expect(Object.keys(launch.environment)).toEqual(['OGI_RUN_DESCRIPTOR']);
        expect(launch.environment.OGI_RUN_DESCRIPTOR).toBe(
          descriptor.descriptorPath
        );
        expect(existsSync(descriptor.backupDirectory)).toBe(true);
        expect(
          readFileSync(join(descriptor.backupDirectory, 'version.txt'), 'utf8')
        ).toBe('v0.0.1-e2e');
        expect(
          readFileSync(
            join(descriptor.installationDirectory, 'version.txt'),
            'utf8'
          )
        ).toBe('v4.1.0-e2e');
        writeFileSync(
          descriptor.startupHealthPath,
          JSON.stringify({
            version: 1,
            runId: descriptor.runId,
            state: 'interactive',
          })
        );
      },
    });

    expect(result.health.state).toBe('interactive');
    expect(existsSync(descriptor.backupDirectory)).toBe(false);
    rmSync(source, { recursive: true, force: true });
  });

  test.each([
    [
      'incomplete content',
      (artifact: Record<string, unknown>) => {
        artifact.files = 'truncated';
      },
    ],
    [
      'unsafe archive paths',
      (artifact: Record<string, unknown>) => {
        artifact.files = [
          {
            path: '../escaped.txt',
            mode: 0o644,
            contents: Buffer.from('unsafe').toString('base64'),
          },
        ];
      },
    ],
    [
      'absent required files',
      (artifact: Record<string, unknown>) => {
        artifact.files = (artifact.files as Array<{ path: string }>).filter(
          (file) => file.path !== 'app/out/preload/index.mjs'
        );
      },
    ],
  ])('rejects %s before replacement and preserves the Last Known-Good Installation', async (_name, corruptArtifact) => {
    const { source, build, descriptor } = createHandoffTestBuild(
      `invalid-candidate-${_name.replaceAll(' ', '-')}`
    );
    const artifact = JSON.parse(
      readFileSync(build.currentApplicationArtifactPath, 'utf8')
    ) as Record<string, unknown>;
    corruptArtifact(artifact);
    const artifactPath = join(source, 'invalid-artifact.json');
    writeFileSync(artifactPath, JSON.stringify(artifact));

    try {
      await expect(
        performRecoverableHandoff({
          descriptor,
          currentApplicationArtifactPath: artifactPath,
          launchApplication: async () => {
            throw new Error('invalid candidate must not launch');
          },
        })
      ).rejects.toThrow();
      expectLastKnownGoodInstallation(descriptor.installationDirectory);
      expect(existsSync(descriptor.backupDirectory)).toBe(false);
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(descriptor.sandboxDirectory, { recursive: true, force: true });
    }
  });

  test.each([
    ['replacement', 'replacement'],
    ['candidate crash', 'launch'],
    ['Startup Health timeout', 'timeout'],
    ['invalid Startup Health', 'invalid-health'],
  ] as const)('restores and relaunches the Last Known-Good Installation after %s failure', async (_name, failurePoint) => {
    const { source, build, descriptor } = createHandoffTestBuild(
      `recovery-${failurePoint}`
    );
    const recoveryPhases: string[] = [];
    let restoredLaunches = 0;
    descriptor.healthTimeoutMs = 1000;

    try {
      await expect(
        performRecoverableHandoff({
          descriptor,
          currentApplicationArtifactPath: build.currentApplicationArtifactPath,
          replaceInstallation:
            failurePoint === 'replacement'
              ? () => {
                  rmSync(descriptor.installationDirectory, {
                    recursive: true,
                    force: true,
                  });
                  mkdirSync(descriptor.installationDirectory, {
                    recursive: true,
                  });
                  writeFileSync(
                    join(descriptor.installationDirectory, 'version.txt'),
                    'v4.1.0-e2e'
                  );
                  expect(
                    existsSync(
                      join(
                        descriptor.installationDirectory,
                        'OpenGameInstaller.AppImage'
                      )
                    )
                  ).toBe(false);
                  expect(
                    existsSync(
                      join(
                        descriptor.installationDirectory,
                        'app/e2e-product-main.cjs'
                      )
                    )
                  ).toBe(false);
                  throw new Error(
                    'replacement fixture failed after partial mutation'
                  );
                }
              : undefined,
          launchApplication: async () => {
            if (failurePoint === 'launch') {
              throw new Error('candidate crashed before Startup Health');
            }
            if (failurePoint === 'invalid-health') {
              writeFileSync(
                descriptor.startupHealthPath,
                JSON.stringify({
                  version: 1,
                  runId: 'wrong-run',
                  state: 'interactive',
                })
              );
            }
          },
          launchLastKnownGood: async (entryPoint) => {
            restoredLaunches += 1;
            expect(entryPoint).toBe(
              join(
                descriptor.installationDirectory,
                'OpenGameInstaller.AppImage'
              )
            );
          },
          onRecoveryPhase: (phase) => recoveryPhases.push(phase),
        })
      ).rejects.toThrow();
      expectLastKnownGoodInstallation(descriptor.installationDirectory);
      expect(existsSync(descriptor.backupDirectory)).toBe(false);
      expect(restoredLaunches).toBe(1);
      expect(recoveryPhases).toEqual([
        'recovery-started',
        'last-known-good-restored',
        'last-known-good-launched',
      ]);
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(descriptor.sandboxDirectory, { recursive: true, force: true });
    }
  });

  test('uses immutable ownership and rejects install-root symlink substitution', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'ogi-fixture-uninstall-'));
    const applicationState = join(sandbox, 'application-state');
    const originalRoot = join(sandbox, 'downloads-original');
    const changedRoot = join(sandbox, 'downloads-changed');
    const installDirectory = join(originalRoot, 'Owned Fixture');
    mkdirSync(applicationState, { recursive: true });
    mkdirSync(installDirectory, { recursive: true });
    mkdirSync(changedRoot, { recursive: true });
    writeFileSync(join(installDirectory, 'fixture.bin'), 'owned');
    writeFileSync(
      join(applicationState, 'current-download-settings.json'),
      JSON.stringify({ fileDownloadLocation: changedRoot }),
      { flag: 'w' }
    );

    try {
      expect(
        deleteOwnedInstallDirectory(
          { installDirectory, installRoot: originalRoot },
          applicationState
        )
      ).toBe(true);
      expect(existsSync(installDirectory)).toBe(false);

      const unownedDirectory = join(sandbox, 'unowned-fixture');
      mkdirSync(unownedDirectory);
      writeFileSync(join(unownedDirectory, 'fixture.bin'), 'unowned');
      expect(() =>
        deleteOwnedInstallDirectory(
          { installDirectory: unownedDirectory, installRoot: originalRoot },
          applicationState
        )
      ).toThrow('directory that owned this install');
      expect(existsSync(unownedDirectory)).toBe(true);

      rmSync(originalRoot, { recursive: true, force: true });
      const unrelatedRoot = join(sandbox, 'unrelated');
      const unrelatedGame = join(unrelatedRoot, 'Game');
      mkdirSync(unrelatedGame, { recursive: true });
      const unrelatedSentinel = join(unrelatedGame, 'sentinel.txt');
      writeFileSync(unrelatedSentinel, 'must remain');
      symlinkSync(
        unrelatedRoot,
        originalRoot,
        process.platform === 'win32' ? 'junction' : 'dir'
      );

      expect(() =>
        deleteOwnedInstallDirectory(
          {
            installDirectory: join(originalRoot, 'Game'),
            installRoot: originalRoot,
          },
          applicationState
        )
      ).toThrow('symbolic-link install ownership root');
      expect(readFileSync(unrelatedSentinel, 'utf8')).toBe('must remain');

      rmSync(originalRoot, { force: true });
      mkdirSync(originalRoot);
      const substitutedComponent = join(originalRoot, 'substituted');
      symlinkSync(
        unrelatedRoot,
        substitutedComponent,
        process.platform === 'win32' ? 'junction' : 'dir'
      );
      expect(() =>
        deleteOwnedInstallDirectory(
          {
            installDirectory: join(substitutedComponent, 'Game'),
            installRoot: originalRoot,
          },
          applicationState
        )
      ).toThrow('symbolic-link install path');
      expect(readFileSync(unrelatedSentinel, 'utf8')).toBe('must remain');
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test('serves the packaged current application from the loopback Fixture Service', async () => {
    const source = mkdtempSync(join(tmpdir(), 'ogi-handoff-fixture-source-'));
    const bundle = join(source, 'bundle');
    mkdirSync(bundle, { recursive: true });
    writeFileSync(join(bundle, 'index.html'), '<h1>Current</h1>');
    for (const name of [
      'e2e-product-main.cjs',
      'e2e-product-updater-main.cjs',
      'fixture-service.cjs',
      'offline-traffic-guard.cjs',
      'application-online-state.mjs',
      'updater-offline-decision.mjs',
      'packaged-handoff-run-descriptor.cjs',
    ]) {
      writeFileSync(join(source, name), `// ${name}\n`);
    }
    const [linuxBuild] = buildPackagedHandoffArtifacts({
      outputDirectory: join(source, 'builds'),
      applicationBundleDirectory: bundle,
      applicationMainPath: join(source, 'e2e-product-main.cjs'),
      applicationOnlineStatePath: join(source, 'application-online-state.mjs'),
      fixtureServicePath: join(source, 'fixture-service.cjs'),
      trafficGuardPath: join(source, 'offline-traffic-guard.cjs'),
      descriptorValidatorPath: join(
        source,
        'packaged-handoff-run-descriptor.cjs'
      ),
      updaterBundleDirectory: bundle,
      updaterPublicDirectory: bundle,
      updaterMainPath: join(source, 'e2e-product-updater-main.cjs'),
      updaterOfflineDecisionPath: join(source, 'updater-offline-decision.mjs'),
      fixtureAddonDirectory: bundle,
      fixtureWebSocketModuleDirectory: bundle,
      updaterUpdateEnginePath: join(
        import.meta.dir,
        '../../updater/src/update-engine.mjs'
      ),
    });
    const fixtureStateDirectory = join(source, 'fixture-state');
    const fixture = await startPackagedHandoffFixture(
      fixtureStateDirectory,
      linuxBuild!.currentApplicationArtifactPath
    );
    try {
      const descriptor = createPackagedHandoffSandbox(
        'fixture-descriptor',
        'linux'
      );
      const configured = writePackagedHandoffRunDescriptor(
        descriptor,
        fixture.baseUrl,
        45678,
        45679,
        45680
      );
      expect(configured.releaseApiUrl).toBe(`${fixture.baseUrl}/releases`);
      expect(configured.artifactUrl).toBe(
        `${fixture.baseUrl}/artifacts/current.json`
      );
      expect(configured.automationPort).toBe(45678);
      expect(configured.clientSdkPort).toBe(45679);
      expect(configured.gameAutomationPort).toBe(45680);
      expect(configured.gameDownloadRecovery).toBe(false);
      expect(configured.fixtureGameLifecycle).toBe(false);
      expect(configured.offlineProductBehavior).toBe(false);
      expect(configured.deterministicTorrentInstallation).toBe(false);
      expect(configured.torrentUrl).toBeNull();
      expect(configured.torrentTrackerUrl).toBeNull();
      expect(configured.torrentPeerPort).toBeNull();
      const recoveryConfigured = writePackagedHandoffRunDescriptor(
        descriptor,
        fixture.baseUrl,
        45678,
        45679,
        45680,
        'none',
        true
      );
      expect(recoveryConfigured.gameDownloadRecovery).toBe(true);
      const lifecycleConfigured = writePackagedHandoffRunDescriptor(
        descriptor,
        fixture.baseUrl,
        45678,
        45679,
        45680,
        'none',
        false,
        true
      );
      expect(lifecycleConfigured.fixtureGameLifecycle).toBe(true);
      const offlineConfigured = writePackagedHandoffRunDescriptor(
        descriptor,
        fixture.baseUrl,
        45678,
        45679,
        45680,
        'none',
        false,
        false,
        true
      );
      expect(offlineConfigured.offlineProductBehavior).toBe(true);

      const torrentFixture = await startPackagedHandoffFixture(
        join(source, 'torrent-fixture-state'),
        linuxBuild!.currentApplicationArtifactPath,
        false,
        undefined,
        'none',
        undefined,
        true
      );
      try {
        expect(torrentFixture.torrent).toEqual({
          torrentUrl: `${torrentFixture.baseUrl}/games/golden-journey.torrent`,
          trackerUrl: expect.stringMatching(
            /^http:\/\/127\.0\.0\.1:\d+\/announce$/
          ),
          trackerAddress: '127.0.0.1',
          peerPort: expect.any(Number),
          peerAddress: expect.stringMatching(/^(?:::|0\.0\.0\.0)$/),
          payloadManifest: FIXTURE_TORRENT_PAYLOAD_MANIFEST,
        });
        const torrentResponse = await fetch(torrentFixture.torrent!.torrentUrl);
        expect(torrentResponse.status).toBe(200);
        expect(torrentResponse.headers.get('content-type')).toBe(
          'application/x-bittorrent'
        );
        const torrentBytes = Buffer.from(await torrentResponse.arrayBuffer());
        expect(torrentBytes.byteLength).toBeGreaterThan(0);
        const { default: WebTorrent } = await import('webtorrent');
        const downloader = new WebTorrent({
          dht: false,
          lsd: false,
          utp: false,
          tracker: true,
          natUpnp: false,
          natPmp: false,
        } as ConstructorParameters<typeof WebTorrent>[0]);
        const torrentDownloadDirectory = join(source, 'torrent-download');
        try {
          await Promise.race([
            new Promise<void>((resolveDownload, rejectDownload) => {
              const downloadedTorrent = downloader.add(
                torrentBytes,
                { path: torrentDownloadDirectory },
                () => {
                  downloadedTorrent.once('done', resolveDownload);
                  downloadedTorrent.once('error', rejectDownload);
                }
              );
            }),
            new Promise<never>((_, rejectTimeout) =>
              setTimeout(
                () =>
                  rejectTimeout(new Error('Local torrent download timed out')),
                30_000
              )
            ),
          ]);
          const downloadedPayloadDirectory = join(
            torrentDownloadDirectory,
            'torrent-payload'
          );
          expect(FIXTURE_TORRENT_PAYLOAD_MANIFEST).toEqual([
            {
              relativePath: 'fixture-game.cjs',
              size: 1558,
              sha256:
                '628540c2e7602e268db1bfc4c86051053cea6852077127325e75e7e10fb90bc1',
            },
            {
              relativePath: 'golden-journey.txt',
              size: 262144,
              sha256:
                '8846ff2659580cdb12a5cf148f83fe269ec61c574336a72cdf45781883bb2968',
            },
          ]);
          expect(
            verifyExactFixtureTree(
              downloadedPayloadDirectory,
              FIXTURE_TORRENT_PAYLOAD_MANIFEST
            )
          ).toEqual(FIXTURE_TORRENT_PAYLOAD_MANIFEST);
          writeFileSync(
            join(downloadedPayloadDirectory, 'fixture-game.cjs'),
            Buffer.from(
              FIXTURE_GAME_MAIN.replace('BrowserWindow', 'BrowserWind0w')
            )
          );
          expect(() =>
            verifyExactFixtureTree(
              downloadedPayloadDirectory,
              FIXTURE_TORRENT_PAYLOAD_MANIFEST
            )
          ).toThrow('fixture-game.cjs SHA-256 mismatch');
        } finally {
          await new Promise<void>((resolveDestroy, rejectDestroy) => {
            downloader.destroy((error) =>
              error ? rejectDestroy(error) : resolveDestroy()
            );
          });
        }
        const torrentConfigured = writePackagedHandoffRunDescriptor(
          descriptor,
          torrentFixture.baseUrl,
          45678,
          45679,
          45680,
          'none',
          false,
          false,
          false,
          'none',
          true,
          torrentFixture.torrent
        );
        expect(torrentConfigured.deterministicTorrentInstallation).toBe(true);
        expect(torrentConfigured.torrentUrl).toBe(
          torrentFixture.torrent!.torrentUrl
        );
        expect(torrentConfigured.torrentTrackerUrl).toBe(
          torrentFixture.torrent!.trackerUrl
        );
        expect(torrentConfigured.torrentPeerPort).toBe(
          torrentFixture.torrent!.peerPort
        );
      } finally {
        await torrentFixture.close();
      }

      const releasesResponse = await fetch(`${fixture.baseUrl}/releases`);
      expect(await releasesResponse.json()).toEqual([
        expect.objectContaining({
          tag_name: 'v4.1.0-e2e',
          assets: [
            expect.objectContaining({
              browser_download_url: `${fixture.baseUrl}/artifacts/current.json`,
              size: readFileSync(linuxBuild!.currentApplicationArtifactPath)
                .byteLength,
              digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
            }),
          ],
        }),
      ]);
      const artifactResponse = await fetch(
        `${fixture.baseUrl}/artifacts/current.json`
      );
      expect(await artifactResponse.text()).toBe(
        readFileSync(linuxBuild!.currentApplicationArtifactPath, 'utf8')
      );
      expect(readFileSync(fixture.requestLogPath, 'utf8')).toContain(
        '"path":"/artifacts/current.json"'
      );
      const gameHeadResponse = await fetch(
        `${fixture.baseUrl}/games/golden-journey.txt`,
        { method: 'HEAD' }
      );
      expect(gameHeadResponse.status).toBe(200);
      expect(gameHeadResponse.headers.get('accept-ranges')).toBe('bytes');
      expect(Number(gameHeadResponse.headers.get('content-length'))).toBe(
        FIXTURE_GAME_CONTENT.byteLength
      );
      const gameResponse = await fetch(
        `${fixture.baseUrl}/games/golden-journey.txt`
      );
      expect(Buffer.from(await gameResponse.arrayBuffer())).toEqual(
        FIXTURE_GAME_CONTENT
      );
      const fixtureGameMainResponse = await fetch(
        `${fixture.baseUrl}/games/fixture-game.cjs`
      );
      expect(await fixtureGameMainResponse.text()).toBe(FIXTURE_GAME_MAIN);
      const terminationStatePath = join(
        fixtureStateDirectory,
        'partial-download-ready.json'
      );
      expect(existsSync(terminationStatePath)).toBe(true);
      expect(JSON.parse(readFileSync(terminationStatePath, 'utf8'))).toEqual({
        bytesServed: FIXTURE_GAME_TERMINATION_BYTES,
        totalBytes: FIXTURE_GAME_CONTENT.byteLength,
      });
      const resumedResponse = await fetch(
        `${fixture.baseUrl}/games/golden-journey.txt`,
        { headers: { Range: `bytes=${FIXTURE_GAME_TERMINATION_BYTES}-` } }
      );
      expect(resumedResponse.status).toBe(206);
      expect(resumedResponse.headers.get('content-range')).toBe(
        `bytes ${FIXTURE_GAME_TERMINATION_BYTES}-${FIXTURE_GAME_CONTENT.byteLength - 1}/${FIXTURE_GAME_CONTENT.byteLength}`
      );
      expect(Buffer.from(await resumedResponse.arrayBuffer())).toEqual(
        FIXTURE_GAME_CONTENT.subarray(FIXTURE_GAME_TERMINATION_BYTES)
      );
      expect(readFileSync(fixture.requestLogPath, 'utf8')).toContain(
        `"range":"bytes=${FIXTURE_GAME_TERMINATION_BYTES}-"`
      );
    } finally {
      await fixture.close();
      rmSync(source, { recursive: true, force: true });
    }
  }, 60_000);

  test('serves valid, corrupt, interrupted, and failed-fallback incremental responses deterministically', async () => {
    const { source, build } = createHandoffTestBuild('incremental-fixture');

    try {
      for (const mode of [
        'valid',
        'corrupt',
        'interrupted',
        'fallback-failure',
      ] as const) {
        const fixture = await startPackagedHandoffFixture(
          join(source, `fixture-${mode}`),
          build.currentApplicationArtifactPath,
          false,
          build.incrementalPatchPath,
          mode,
          build.incrementalOldBlockmapPath
        );
        try {
          const releaseResponse = await fetch(`${fixture.baseUrl}/releases`);
          const releases = (await releaseResponse.json()) as Array<{
            tag_name: string;
            assets: Array<{ browser_download_url: string }>;
          }>;
          expect(releases.map((release) => release.tag_name)).toEqual([
            'v4.1.0-e2e',
            'v4.0.0-e2e',
          ]);
          const patchResponse = await fetch(
            `${fixture.baseUrl}/artifacts/current.json.blockmap`
          );
          const patchBytes = Buffer.from(await patchResponse.arrayBuffer());
          if (mode === 'valid') {
            expect(
              JSON.parse(gunzipSync(patchBytes).toString('utf8'))
            ).toMatchObject({ version: '2' });
          } else if (mode === 'interrupted') {
            expect(() => gunzipSync(patchBytes)).toThrow();
          } else {
            const corrupt = JSON.parse(gunzipSync(patchBytes).toString('utf8'));
            expect(corrupt.files[0].checksums[0]).toBe('A'.repeat(24));
          }
          const fullResponse = await fetch(
            `${fixture.baseUrl}/artifacts/current.json`
          );
          expect(fullResponse.status).toBe(
            mode === 'fallback-failure' ? 503 : 200
          );
        } finally {
          await fixture.close();
        }
      }
    } finally {
      rmSync(source, { recursive: true, force: true });
    }
  });

  test('seeds a current Last Known-Good Installation and installed fixture for offline UI use', () => {
    const { source, build, descriptor } = createHandoffTestBuild(
      'offline-product-state'
    );

    try {
      installPackagedApplicationArtifact(
        descriptor,
        build.currentApplicationArtifactPath
      );
      const seeded = seedOfflineFixtureGame(descriptor, '/opt/electron');

      expect(
        readFileSync(
          join(descriptor.installationDirectory, 'version.txt'),
          'utf8'
        )
      ).toBe('v4.1.0-e2e');
      expect(
        existsSync(
          join(descriptor.installationDirectory, 'app/e2e-product-main.cjs')
        )
      ).toBe(true);
      expect(JSON.parse(readFileSync(seeded.libraryPath, 'utf8'))).toEqual(
        expect.objectContaining({
          appID: 7001,
          name: 'Golden Journey Fixture',
          installDirectory: seeded.installDirectory,
          launchExecutable: seeded.launchExecutable,
        })
      );
      expect(
        readFileSync(join(seeded.installDirectory, 'golden-journey.txt'))
      ).toEqual(FIXTURE_GAME_CONTENT);
      expect(readFileSync(seeded.launchExecutable, 'utf8')).toContain(
        'electron'
      );
      expect(
        JSON.parse(
          readFileSync(
            join(
              descriptor.applicationStateDirectory,
              'config/option/installed.json'
            ),
            'utf8'
          )
        )
      ).toEqual({ installed: true });
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(descriptor.sandboxDirectory, { recursive: true, force: true });
    }
  });

  test('returns no-op offline readiness without loading addon runtimes', async () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'ogi-offline-fixture-runtime-'));
    const applicationState = join(sandbox, 'application-state');
    const fixtureAddonDist = join(
      sandbox,
      'installation/app/ogi-e2e-fixture-addon/dist'
    );
    mkdirSync(fixtureAddonDist, { recursive: true });
    mkdirSync(applicationState, { recursive: true });
    writeFileSync(
      join(fixtureAddonDist, 'library-runtime.cjs'),
      `module.exports = {
        ensureLibraryDir() {},
        getAllLibraryFiles() { return []; },
        loadLibraryInfo() { return null; },
        removeFromInternalsApps() {},
        removeLibraryFile() {},
        saveLibraryInfo() {},
        uninstallGameFromLibrary() { return { filesRemoved: false }; },
      };`
    );
    writeFileSync(
      join(fixtureAddonDist, 'addon-runtime.cjs'),
      `throw new Error('offline addon runtime must not be loaded');`
    );
    writeFileSync(
      join(fixtureAddonDist, 'download-runtime.cjs'),
      `throw new Error('offline download runtime must not be loaded');`
    );
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const ipcMain = {
      on(channel: string, handler: (...args: unknown[]) => void) {
        listeners.set(channel, handler);
      },
      handle() {},
    };

    try {
      const close = registerFixtureService(
        ipcMain,
        applicationState,
        'http://127.0.0.1:1',
        sandbox,
        45678,
        false
      );
      await close.ready;
      expect(listeners.has('client-ready-for-events')).toBe(false);
      await close();
      await close();
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test('uses the production updater and application offline decisions', async () => {
    const applicationOnline = await import(
      '../../application/src/electron/lib/online-state.mjs'
    );
    const updaterOffline = await import(
      '../../updater/src/offline-decision.mjs'
    );

    expect(
      applicationOnline.resolveEffectiveOnlineState(
        applicationOnline.getRequestedOnlineState(['--online=false']),
        true
      )
    ).toEqual({
      requestedOnline: false,
      networkOnline: true,
      effectiveOnline: false,
      reason: 'cli-offline',
    });
    expect(
      updaterOffline.decideUpdaterStartup(['--online=false'], true)
    ).toEqual({
      onlineState: {
        requestedOnline: false,
        networkOnline: true,
        effectiveOnline: false,
        reason: 'cli-offline',
      },
      action: 'skip-update-and-launch-offline',
    });
    expect(updaterOffline.decideUpdaterStartup([], true).action).toBe(
      'check-for-updates'
    );
  });

  test('reports denied and unexpected offline traffic instead of inferring silence', async () => {
    const expectedEndpoints = [{ host: '127.0.0.1', port: 7654 }];
    expect(classifyUrl('https://example.com/releases', expectedEndpoints)).toBe(
      'unexpected'
    );
    expect(classifyUrl('wss://example.com/socket', expectedEndpoints)).toBe(
      'unexpected'
    );
    expect(
      classifyUrl('http://127.0.0.1:7654/fixture', expectedEndpoints)
    ).toBe('expected');
    expect(classifyUrl('ws://127.0.0.1:9999/sdk', expectedEndpoints)).toBe(
      'unexpected'
    );
    expect(classifyUrl('file:///sandbox/index.html', expectedEndpoints)).toBe(
      'ignored'
    );
    expect(
      requestUrl('http:', {
        socketPath: '/tmp/ogi-http.sock',
        path: '/status',
      })
    ).toBeNull();
    expect(
      requestUrl('https:', {
        socketPath: String.raw`\\.\pipe\ogi-http`,
        path: '/status',
      })
    ).toBeNull();
    expect(
      requestUrl('http:', 'http://ignored.example/status', {
        socketPath: '/tmp/ogi-http.sock',
        path: '/status',
      })
    ).toBeNull();
    expect(
      requestUrl('https:', new URL('https://ignored.example/status'), {
        socketPath: String.raw`\\.\pipe\ogi-https`,
        path: '/status',
      })
    ).toBeNull();
    expect(
      requestUrl('http:', {
        hostname: '127.0.0.1',
        port: 7654,
        path: '/status',
      })
    ).toBe('http://127.0.0.1:7654/status');

    const directory = mkdtempSync(join(tmpdir(), 'ogi-offline-traffic-check-'));
    const updaterLog = join(directory, 'updater.jsonl');
    const applicationLog = join(directory, 'application.jsonl');
    const fixtureLog = join(directory, 'fixture.jsonl');
    writeFileSync(
      updaterLog,
      `${JSON.stringify({ target: 'https://example.com/releases', decision: 'unexpected', expected: false })}\n`
    );
    writeFileSync(
      applicationLog,
      `${JSON.stringify({ target: 'ws://127.0.0.1:7654', decision: 'expected', expected: true })}\n`
    );
    writeFileSync(
      fixtureLog,
      `${JSON.stringify({ method: 'GET', path: '/unexpected', status: 404, unexpected: true })}\n`
    );

    expect(
      findUnexpectedOfflineTraffic([updaterLog, applicationLog], fixtureLog)
    ).toEqual([
      expect.objectContaining({
        source: updaterLog,
        decision: 'unexpected',
        expected: false,
      }),
      expect.objectContaining({ source: fixtureLog, unexpected: true }),
    ]);
    writeFileSync(updaterLog, '');
    writeFileSync(fixtureLog, '');
    expect(
      findUnexpectedOfflineTraffic([updaterLog, applicationLog], fixtureLog)
    ).toEqual([]);

    const probeLog = join(directory, 'probe.jsonl');
    const guardPath = join(import.meta.dir, '../offline-traffic-guard.cjs');
    const probe = spawnSync(
      process.platform === 'win32' ? 'node.exe' : 'node',
      [
        '-e',
        `for (const [moduleName, url] of [['node:http', 'http://127.0.0.1:9999/probe'], ['node:https', 'https://example.com/probe']]) { try { require(moduleName).get(url); } catch (error) { console.error(error.message); } }`,
      ],
      {
        env: {
          ...process.env,
          OGI_OFFLINE_TRAFFIC_GUARD_CONFIG: JSON.stringify({
            logPath: probeLog,
            product: 'traffic-probe',
            expectedEndpoints: [],
          }),
          NODE_OPTIONS: `--require=${guardPath}`,
        },
        encoding: 'utf8',
      }
    );
    expect(probe.status).toBe(0);
    const probeEntries = readFileSync(probeLog, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(probeEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          transport: 'node-http',
          expected: false,
          target: 'http://127.0.0.1:9999/probe',
        }),
        expect.objectContaining({
          transport: 'node-https',
          expected: false,
          target: 'https://example.com/probe',
        }),
      ])
    );
    expect(probe.stderr).toContain('Offline traffic guard denied');

    const prototypeProbeLog = join(directory, 'prototype-probe.jsonl');
    const prototypeProbe = spawnSync(
      process.platform === 'win32' ? 'node.exe' : 'node',
      [
        '-e',
        `const net = require('node:net'); const tls = require('node:tls'); for (const connect of [() => new net.Socket().connect({ host: '127.0.0.1', port: 9998 }), () => new tls.TLSSocket(new net.Socket()).connect({ host: '127.0.0.1', port: 9997 })]) { try { connect(); } catch (error) { console.error(error.message); } }`,
      ],
      {
        env: {
          ...process.env,
          OGI_OFFLINE_TRAFFIC_GUARD_CONFIG: JSON.stringify({
            logPath: prototypeProbeLog,
            product: 'prototype-traffic-probe',
            expectedEndpoints: [],
          }),
          NODE_OPTIONS: `--require=${guardPath}`,
        },
        encoding: 'utf8',
      }
    );
    expect(prototypeProbe.status).toBe(0);
    const prototypeEntries = readFileSync(prototypeProbeLog, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(prototypeEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          transport: 'node-net-socket-prototype',
          target: '127.0.0.1:9998',
          expected: false,
        }),
        expect.objectContaining({
          transport: 'node-tls-socket-prototype',
          target: '127.0.0.1:9997',
          expected: false,
        }),
      ])
    );
    expect(prototypeProbe.stderr).toContain('Offline traffic guard denied');

    if (process.platform !== 'win32') {
      const ipcProbeLog = join(directory, 'http-ipc-probe.jsonl');
      const socketPath = join(directory, 'http-ipc.sock');
      const ipcProbe = spawnSync(
        'node',
        [
          '-e',
          `const fs = require('node:fs'); const http = require('node:http'); const socketPath = process.argv[1]; const server = http.createServer((request, response) => { response.end(request.url); }); server.listen(socketPath, async () => { const read = (response, resolve) => { response.resume(); response.on('end', resolve); }; const getOptionsFirst = new Promise((resolve, reject) => http.get({ socketPath, path: '/get-options' }, (response) => read(response, resolve)).on('error', reject)); const requestOptionsFirst = new Promise((resolve, reject) => { const req = http.request({ socketPath, path: '/request-options', method: 'POST' }, (response) => read(response, resolve)); req.on('error', reject); req.end(); }); const getUrlFirst = new Promise((resolve, reject) => http.get('http://ignored.example/get-url', { socketPath, path: '/get-url' }, (response) => read(response, resolve)).on('error', reject)); const requestUrlFirst = new Promise((resolve, reject) => { const req = http.request(new URL('http://ignored.example/request-url'), { socketPath, path: '/request-url', method: 'POST' }, (response) => read(response, resolve)); req.on('error', reject); req.end(); }); try { await Promise.all([getOptionsFirst, requestOptionsFirst, getUrlFirst, requestUrlFirst]); server.close(() => { fs.rmSync(socketPath, { force: true }); process.exit(0); }); } catch (error) { console.error(error); process.exit(2); } }); setTimeout(() => process.exit(3), 3000);`,
          socketPath,
        ],
        {
          env: {
            ...process.env,
            OGI_OFFLINE_TRAFFIC_GUARD_CONFIG: JSON.stringify({
              logPath: ipcProbeLog,
              product: 'http-ipc-probe',
              expectedEndpoints: [],
            }),
            NODE_OPTIONS: `--require=${guardPath}`,
          },
          encoding: 'utf8',
          timeout: 5000,
        }
      );
      expect(ipcProbe.status).toBe(0);
      expect(ipcProbe.stderr).toBe('');
      const ipcEntries = readFileSync(ipcProbeLog, 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      expect(ipcEntries).toEqual([
        expect.objectContaining({
          transport: 'guard-install',
          expected: true,
        }),
      ]);
    }

    const udpProbeLog = join(directory, 'udp-probe.jsonl');
    const udpProbe = spawnSync(
      process.platform === 'win32' ? 'node.exe' : 'node',
      [
        '-e',
        `const dgram = require('node:dgram'); let customLookupCalled = false; const deniedSend = dgram.createSocket('udp4'); try { deniedSend.send(Buffer.from('x'), 9999, '127.0.0.1', () => process.exit(10)); } catch (error) { console.error(error.message); } deniedSend.close(); const deniedConnect = dgram.createSocket('udp4'); try { deniedConnect.connect(9998, '127.0.0.1', () => process.exit(11)); } catch (error) { console.error(error.message); } deniedConnect.close(); const custom = dgram.createSocket({ type: 'udp4', lookup(hostname, options, callback) { customLookupCalled = true; callback(null, '127.0.0.1', 4); } }); try { custom.send(Buffer.from('x'), 7656, 'allowed.test', () => process.exit(12)); } catch (error) { console.error(error.message); } custom.close(); const send4 = new Promise((resolve, reject) => { const socket = dgram.createSocket('udp4'); socket.send(Buffer.from('v4'), 7654, '127.0.0.1', (error) => { socket.close(); error ? reject(error) : resolve(); }); }); const connect4 = new Promise((resolve, reject) => { const socket = dgram.createSocket('udp4'); socket.connect(7654, '127.0.0.1', () => socket.send(Buffer.from('connected'), (error) => { socket.close(); error ? reject(error) : resolve(); })); socket.on('error', reject); }); const send6 = new Promise((resolve, reject) => { const socket = dgram.createSocket('udp6'); socket.send(Buffer.from('v6'), 7655, '::1', (error) => { socket.close(); error ? reject(error) : resolve(); }); }); Promise.all([send4, connect4, send6]).then(() => { if (customLookupCalled) process.exit(13); process.exit(0); }, (error) => { console.error(error); process.exit(2); }); setTimeout(() => process.exit(3), 3000);`,
      ],
      {
        env: {
          ...process.env,
          OGI_OFFLINE_TRAFFIC_GUARD_CONFIG: JSON.stringify({
            logPath: udpProbeLog,
            product: 'udp-traffic-probe',
            expectedEndpoints: [
              { host: '127.0.0.1', port: 7654 },
              { host: '::1', port: 7655 },
              { host: 'allowed.test', port: 7656 },
            ],
          }),
          NODE_OPTIONS: `--require=${guardPath}`,
        },
        encoding: 'utf8',
        timeout: 5000,
      }
    );
    expect(udpProbe.status).toBe(0);
    const udpEntries = readFileSync(udpProbeLog, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(udpEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          transport: 'node-dgram-send',
          target: '127.0.0.1:9999',
          expected: false,
        }),
        expect.objectContaining({
          transport: 'node-dgram-connect',
          target: '127.0.0.1:9998',
          expected: false,
        }),
        expect.objectContaining({
          transport: 'node-dgram-send',
          target: 'allowed.test:7656',
          expected: false,
        }),
        expect.objectContaining({
          transport: 'node-dgram-send',
          target: '127.0.0.1:7654',
          expected: true,
        }),
        expect.objectContaining({
          transport: 'node-dgram-connect',
          target: '127.0.0.1:7654',
          expected: true,
        }),
        expect.objectContaining({
          transport: 'node-dgram-send',
          target: '::1:7655',
          expected: true,
        }),
      ])
    );
    expect(udpProbe.stderr).toContain('Offline traffic guard denied');

    const dnsProbeLog = join(directory, 'dns-probe.jsonl');
    const dnsProbe = spawnSync(
      process.platform === 'win32' ? 'node.exe' : 'node',
      [
        '-e',
        `const dgram = require('node:dgram'); const dns = require('node:dns'); let packets = 0; const server = dgram.createSocket('udp4'); server.on('message', () => { packets += 1; }); server.bind(9999, '127.0.0.1', async () => { const attempt = (fn) => { try { fn(); } catch (error) { console.error(error.message); } }; const resolver = new dns.Resolver(); attempt(() => resolver.setServers(['127.0.0.1:9999'])); attempt(() => resolver.setServers(['127.0.0.1:5353'])); attempt(() => resolver.resolve4('resolver.example', () => process.exit(10))); attempt(() => dns.setServers(['127.0.0.1:9999'])); attempt(() => dns.setServers(['127.0.0.1:5353'])); attempt(() => dns.reverse('127.0.0.1', () => process.exit(11))); attempt(() => dns.lookupService('127.0.0.1', 80, () => process.exit(12))); attempt(() => dns.resolveTlsa('resolver.example', () => process.exit(13))); const promiseResolver = new dns.promises.Resolver(); attempt(() => promiseResolver.setServers(['127.0.0.1:5353'])); const rejected = async (promise) => { try { await promise; process.exit(14); } catch (error) { console.error(error.message); } }; await Promise.all([rejected(promiseResolver.resolve4('promise-resolver.example')), rejected(dns.promises.reverse('127.0.0.1')), rejected(dns.promises.lookupService('127.0.0.1', 80))]); await new Promise((resolve, reject) => dns.lookup('127.0.0.1', (error) => error ? reject(error) : resolve())); await dns.promises.lookup('::1'); setTimeout(() => { server.close(); process.exit(packets === 0 ? 0 : 15); }, 100); }); setTimeout(() => process.exit(3), 3000);`,
      ],
      {
        env: {
          ...process.env,
          OGI_OFFLINE_TRAFFIC_GUARD_CONFIG: JSON.stringify({
            logPath: dnsProbeLog,
            product: 'dns-traffic-probe',
            expectedEndpoints: [
              { host: '127.0.0.1', port: 5353 },
              { host: '127.0.0.1', port: 7654 },
            ],
          }),
          NODE_OPTIONS: `--require=${guardPath}`,
        },
        encoding: 'utf8',
        timeout: 5000,
      }
    );
    expect(dnsProbe.status).toBe(0);
    const dnsEntries = readFileSync(dnsProbeLog, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(dnsEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          transport: 'node-dns-resolver:setServers',
          target: '127.0.0.1:9999',
          expected: false,
        }),
        expect.objectContaining({
          transport: 'node-dns-resolver:setServers',
          target: '127.0.0.1:5353',
          expected: true,
        }),
        expect.objectContaining({
          transport: 'node-dns-resolver:resolve4',
          target: 'resolver.example',
          expected: false,
        }),
        expect.objectContaining({
          transport: 'node-dns-resolver:reverse',
          target: '127.0.0.1',
          expected: false,
        }),
        expect.objectContaining({
          transport: 'node-dns:lookupService',
          target: '127.0.0.1:80',
          expected: false,
        }),
        expect.objectContaining({
          transport: 'node-dns-resolver:resolveTlsa',
          target: 'resolver.example',
          expected: false,
        }),
        expect.objectContaining({
          transport: 'node-dns-promises-resolver:resolve4',
          target: 'promise-resolver.example',
          expected: false,
        }),
        expect.objectContaining({
          transport: 'node-dns-promises-resolver:reverse',
          target: '127.0.0.1',
          expected: false,
        }),
      ])
    );
    expect(dnsProbe.stderr).toContain('Offline traffic guard denied');

    const expectedServer = createServer((socket) => socket.end());
    await new Promise<void>((resolve, reject) => {
      expectedServer.once('error', reject);
      expectedServer.listen(0, '127.0.0.1', () => {
        expectedServer.off('error', reject);
        resolve();
      });
    });
    const address = expectedServer.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected endpoint server did not allocate a port');
    }
    const expectedProbeLog = join(directory, 'expected-probe.jsonl');
    const expectedProbe = spawnSync(
      process.platform === 'win32' ? 'node.exe' : 'node',
      [
        '-e',
        `const net = require('node:net'); net.connect({ host: '127.0.0.1', port: ${address.port} }, () => process.exit(0)); setTimeout(() => process.exit(2), 2000);`,
      ],
      {
        env: {
          ...process.env,
          OGI_OFFLINE_TRAFFIC_GUARD_CONFIG: JSON.stringify({
            logPath: expectedProbeLog,
            product: 'expected-traffic-probe',
            expectedEndpoints: [{ host: '127.0.0.1', port: address.port }],
          }),
          NODE_OPTIONS: `--require=${guardPath}`,
        },
        encoding: 'utf8',
        timeout: 5000,
      }
    );
    await new Promise<void>((resolve, reject) => {
      expectedServer.close((error) => (error ? reject(error) : resolve()));
    });
    expect(expectedProbe.status).toBe(0);
    const expectedConnectEntries = readFileSync(expectedProbeLog, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter(
        (entry) =>
          entry.transport === 'node-net-socket-prototype' &&
          entry.method === 'CONNECT'
      );
    expect(expectedConnectEntries).toEqual([
      expect.objectContaining({
        target: `127.0.0.1:${address.port}`,
        expected: true,
      }),
    ]);
    rmSync(directory, { recursive: true, force: true });
  });

  test('records the actual TCP address of wildcard WebTorrent-style listeners', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ogi-listener-check-'));
    const listenerLog = join(directory, 'listener.jsonl');
    const guardPath = join(import.meta.dir, '../offline-traffic-guard.cjs');
    const probe = spawnSync(
      process.platform === 'win32' ? 'node.exe' : 'node',
      [
        '-e',
        `const net = require('node:net'); const server = net.createServer(); server.listen(0, () => server.close(() => process.exit(0))); setTimeout(() => process.exit(2), 3000);`,
      ],
      {
        env: {
          ...process.env,
          OGI_OFFLINE_TRAFFIC_GUARD_CONFIG: JSON.stringify({
            logPath: listenerLog,
            product: 'listener-probe',
            expectedEndpoints: [],
            recordListeners: true,
          }),
          NODE_OPTIONS: `--require=${guardPath}`,
        },
        encoding: 'utf8',
        timeout: 5000,
      }
    );
    expect(probe.status).toBe(0);
    const listeners = readFileSync(listenerLog, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.transport === 'node-net-listen');
    expect(listeners).toEqual([
      expect.objectContaining({
        target: expect.stringMatching(/^(?:::|0\.0\.0\.0):\d+$/),
        method: 'LISTEN',
        expected: true,
      }),
    ]);
    rmSync(directory, { recursive: true, force: true });
  });

  test('reports unhandled runtime failures without treating expected Chromium diagnostics as fatal', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ogi-runtime-log-check-'));
    const cleanLog = join(directory, 'clean.log');
    const failedLog = join(directory, 'failed.log');
    writeFileSync(
      cleanLog,
      '[123:ERROR:dbus/object_proxy.cc] Failed to call desktop service\n'
    );
    writeFileSync(
      failedLog,
      '(node:123) UnhandledPromiseRejectionWarning: Error: Websocket is not open\n'
    );

    expect(findUnexpectedRuntimeLogErrors([cleanLog])).toEqual([]);
    expect(findUnexpectedRuntimeLogErrors([cleanLog, failedLog])).toEqual([
      {
        path: failedLog,
        line: '(node:123) UnhandledPromiseRejectionWarning: Error: Websocket is not open',
      },
    ]);
    rmSync(directory, { recursive: true, force: true });
  });

  test('fails the production boundary when a packaged input contains an active hook', () => {
    const repository = mkdtempSync(join(tmpdir(), 'ogi-production-boundary-'));
    mkdirSync(join(repository, 'application/out'), { recursive: true });
    mkdirSync(join(repository, 'updater/dist'), { recursive: true });
    writeFileSync(
      join(repository, 'application/package.json'),
      JSON.stringify({ build: { files: ['out/**/*'] } })
    );
    writeFileSync(
      join(repository, 'updater/package.json'),
      JSON.stringify({ build: { files: ['dist/**/*'] } })
    );
    writeFileSync(
      join(repository, 'application/out/index.js'),
      'const descriptor = process.env.OGI_RUN_DESCRIPTOR;'
    );
    writeFileSync(join(repository, 'updater/dist/main.js'), 'production');

    try {
      const boundary = verifyProductionPackagingBoundary(repository);
      expect(boundary.activeHookMatches).toEqual(['application/out/index.js']);
      expect(() => assertProductionPackagingBoundary(boundary)).toThrow(
        'Production packaging contains active E2E hooks'
      );
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  test('ordinary production packaging contains no active Run Descriptor or E2E handoff hook', () => {
    const report = verifyProductionPackagingBoundary(
      join(import.meta.dir, '../..')
    );

    expect(report.applicationIncludedPaths).toEqual([
      'public/**/*',
      'out/**/*',
      'node_modules/**/*',
    ]);
    expect(report.updaterIncludedPaths).toEqual(['public/**/*', 'dist/**/*']);
    expect(report.activeHookMatches).toEqual([]);
  });

  test('retries one failed Product Journey in a fresh sandbox and classifies it Flaky', () => {
    const root = mkdtempSync(join(tmpdir(), 'ogi-reliable-product-journey-'));
    const runnerPath = join(root, 'attempt-runner.ts');
    const attemptsPath = join(root, 'attempts.jsonl');
    writeFileSync(
      runnerPath,
      `import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const attempt = Number(process.env.OGI_SCENARIO_ATTEMPT);
const sandboxDirectory = process.env.OGI_PACKAGED_ATTEMPT_SANDBOX!;
mkdirSync(join(sandboxDirectory, 'artifacts'), { recursive: true });
writeFileSync(join(sandboxDirectory, '.ogi-attempt-owner.json'), JSON.stringify({ version: 1, token: process.env.OGI_PACKAGED_ATTEMPT_OWNERSHIP_TOKEN, sandboxDirectory }), { mode: 0o400 });
writeFileSync(join(sandboxDirectory, 'report.html'), '<p>attempt</p>');
writeFileSync(join(sandboxDirectory, 'artifacts/reliability.json'), '{}');
appendFileSync(process.env.OGI_STUB_ATTEMPTS!, JSON.stringify({ attempt, sandboxDirectory }) + '\\n');
const outcome = attempt === 1 ? 'Failed' : 'Passed';
writeFileSync(process.env.OGI_PACKAGED_ATTEMPT_RESULT!, JSON.stringify({ runId: 'worker-' + attempt, sandboxDirectory, outcome, failure: outcome === 'Failed' ? 'assertion failed' : '' }));
process.exitCode = outcome === 'Passed' ? 0 : 1;
`
    );

    try {
      const result = spawnSync(
        process.execPath,
        [join(import.meta.dir, '../src/run-reliable-packaged-handoff.ts')],
        {
          env: {
            ...process.env,
            OGI_E2E_RUN_ROOT: root,
            OGI_PACKAGED_ATTEMPT_RUNNER: runnerPath,
            OGI_STUB_ATTEMPTS: attemptsPath,
          },
          encoding: 'utf8',
        }
      );
      expect(result.status).toBe(1);
      const aggregateDirectory = result.stdout
        .match(/Scenario Sandbox: (.+)/)?.[1]
        ?.trim();
      expect(aggregateDirectory).toBeTruthy();
      const report = JSON.parse(
        readFileSync(join(aggregateDirectory!, 'reliability.json'), 'utf8')
      );
      expect(report).toMatchObject({
        outcome: 'Flaky',
        attempts: ['Failed', 'Passed'],
        requiredCheck: { passed: false, exitCode: 1 },
        retained: true,
      });
      expect(
        readFileSync(attemptsPath, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line).attempt)
      ).toEqual([1, 2]);
      expect(
        existsSync(join(aggregateDirectory!, 'attempt-1/report.html'))
      ).toBe(true);
      expect(
        existsSync(join(aggregateDirectory!, 'attempt-2/report.html'))
      ).toBe(true);
      expect(
        readFileSync(join(aggregateDirectory!, 'events.jsonl'), 'utf8')
      ).toContain('retry.scheduled');
      const html = readFileSync(
        join(aggregateDirectory!, 'report.html'),
        'utf8'
      );
      for (const href of [...html.matchAll(/href="([^"]+)"/g)].map(
        (match) => match[1]!
      )) {
        expect(existsSync(join(aggregateDirectory!, href))).toBe(true);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.each([
    'passed-then-exit-one',
    'passed-then-signal',
    'truncated-result',
    'invalid-schema',
  ] as const)('retains complete infrastructure evidence for %s worker completion', (mode) => {
    if (mode === 'passed-then-signal' && process.platform === 'win32') return;
    const root = mkdtempSync(join(tmpdir(), `ogi-reliable-${mode}-`));
    const runnerPath = join(root, 'attempt-runner.ts');
    writeFileSync(
      runnerPath,
      `import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const mode = process.env.OGI_STUB_RESULT_MODE!;
const sandboxDirectory = process.env.OGI_PACKAGED_ATTEMPT_SANDBOX!;
mkdirSync(join(sandboxDirectory, 'artifacts'), { recursive: true });
writeFileSync(join(sandboxDirectory, '.ogi-attempt-owner.json'), JSON.stringify({ version: 1, token: process.env.OGI_PACKAGED_ATTEMPT_OWNERSHIP_TOKEN, sandboxDirectory }), { mode: 0o400 });
writeFileSync(join(sandboxDirectory, 'report.html'), '<p>retained attempt diagnostics</p>');
writeFileSync(join(sandboxDirectory, 'artifacts/worker.log'), mode + '\\n');
const valid = { runId: 'adversarial-worker', sandboxDirectory, outcome: 'Passed', failure: '' };
if (mode === 'truncated-result') {
  writeFileSync(process.env.OGI_PACKAGED_ATTEMPT_RESULT!, '{"runId":');
} else if (mode === 'invalid-schema') {
  writeFileSync(process.env.OGI_PACKAGED_ATTEMPT_RESULT!, JSON.stringify({ ...valid, outcome: 'Unknown' }));
} else {
  writeFileSync(process.env.OGI_PACKAGED_ATTEMPT_RESULT!, JSON.stringify(valid));
}
if (mode === 'passed-then-exit-one') process.exit(1);
if (mode === 'passed-then-signal') process.kill(process.pid, 'SIGTERM');
`
    );

    try {
      const result = spawnSync(
        process.execPath,
        [join(import.meta.dir, '../src/run-reliable-packaged-handoff.ts')],
        {
          env: {
            ...process.env,
            OGI_E2E_RUN_ROOT: root,
            OGI_PACKAGED_ATTEMPT_RUNNER: runnerPath,
            OGI_STUB_RESULT_MODE: mode,
          },
          encoding: 'utf8',
        }
      );
      expect(result.status).toBe(1);
      const aggregateDirectory = result.stdout
        .match(/Scenario Sandbox: (.+)/)?.[1]
        ?.trim();
      expect(aggregateDirectory).toBeTruthy();
      const report = JSON.parse(
        readFileSync(join(aggregateDirectory!, 'reliability.json'), 'utf8')
      );
      expect(report).toMatchObject({
        outcome: 'Infrastructure Failed',
        attempts: ['Infrastructure Failed'],
        requiredCheck: { passed: false, exitCode: 1 },
        retained: true,
      });
      if (mode === 'passed-then-exit-one') {
        expect(report.infrastructureDetail).toContain('exited with status 1');
      } else if (mode === 'passed-then-signal') {
        expect(report.infrastructureDetail).toContain(
          'terminated by signal SIGTERM'
        );
      } else {
        expect(report.infrastructureDetail).toContain(
          'attempt result is invalid'
        );
      }
      const events = readFileSync(
        join(aggregateDirectory!, 'events.jsonl'),
        'utf8'
      );
      expect(events).toContain('"type":"attempt.completed"');
      expect(events).toContain('"outcome":"Infrastructure Failed"');
      expect(events).not.toContain('retry.scheduled');
      expect(
        existsSync(join(aggregateDirectory!, 'attempt-1/report.html'))
      ).toBe(true);
      expect(
        existsSync(join(aggregateDirectory!, 'attempt-1/artifacts/worker.log'))
      ).toBe(true);
      for (const artifact of [
        'events.jsonl',
        'reliability.json',
        'report.html',
        'summary.json',
        'retention.json',
      ]) {
        expect(existsSync(join(aggregateDirectory!, artifact))).toBe(true);
      }
      const html = readFileSync(
        join(aggregateDirectory!, 'report.html'),
        'utf8'
      );
      for (const href of [...html.matchAll(/href="([^"]+)"/g)].map(
        (match) => match[1]!
      )) {
        expect(existsSync(join(aggregateDirectory!, href))).toBe(true);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  test('cancels and cleans the aggregate Product Journey attempt process tree', async () => {
    if (process.platform === 'win32') return;
    const root = mkdtempSync(join(tmpdir(), 'ogi-reliable-cancel-'));
    const runnerPath = join(root, 'attempt-runner.ts');
    const processPath = join(root, 'processes.json');
    writeFileSync(
      runnerPath,
      `import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeRunEventWriter } from ${JSON.stringify(join(import.meta.dir, '../src/run-events.ts'))};
const root = process.env.OGI_E2E_RUN_ROOT!;
const sandboxDirectory = process.env.OGI_PACKAGED_ATTEMPT_SANDBOX!;
const foreignDirectory = join(root, 'product-journey-foreign-active');
mkdirSync(join(sandboxDirectory, 'artifacts'), { recursive: true });
writeFileSync(join(sandboxDirectory, '.ogi-attempt-owner.json'), JSON.stringify({ version: 1, token: process.env.OGI_PACKAGED_ATTEMPT_OWNERSHIP_TOKEN, sandboxDirectory }), { mode: 0o400 });
writeFileSync(join(sandboxDirectory, 'run-descriptor.json'), JSON.stringify({ version: 1, runId: 'cancel-worker', sandboxDirectory }));
writeFileSync(join(sandboxDirectory, 'artifacts/main.log'), 'worker evidence\\n');
writeFileSync(join(sandboxDirectory, 'artifacts/failure.png'), 'screenshot evidence');
const writeEvent = makeRunEventWriter(join(sandboxDirectory, 'events.jsonl'), 'cancel-worker');
writeEvent({ type: 'run.started', payload: { platform: process.platform } });
writeEvent({ type: 'scenario.started', payload: { scenarioId: 'cancel-worker', kind: 'Product Journey' } });
writeEvent({ type: 'attempt.started', payload: { scenarioId: 'cancel-worker', attempt: 1 } });
writeEvent({ type: 'step.started', payload: { stepId: 'in-progress', name: 'Capture cancellation evidence' } });
mkdirSync(foreignDirectory);
writeFileSync(join(foreignDirectory, 'foreign-sentinel.txt'), 'unrelated active run');
const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
if (!descendant.pid) throw new Error('descendant did not start');
descendant.unref();
writeFileSync(${JSON.stringify(processPath)}, JSON.stringify({ worker: process.pid, descendant: descendant.pid, sandboxDirectory, foreignDirectory }));
await Bun.sleep(30_000);
`
    );
    const child = spawn(
      process.execPath,
      [join(import.meta.dir, '../src/run-reliable-packaged-handoff.ts')],
      {
        env: {
          ...process.env,
          OGI_E2E_RUN_ROOT: root,
          OGI_PACKAGED_ATTEMPT_RUNNER: runnerPath,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    let stdout = '';
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });

    try {
      const deadline = Date.now() + 3_000;
      while (!existsSync(processPath) && Date.now() < deadline) {
        await Bun.sleep(25);
      }
      expect(existsSync(processPath)).toBe(true);
      child.kill('SIGTERM');
      const status = await new Promise<number | null>((resolveExit) =>
        child.once('exit', resolveExit)
      );
      expect(status).toBe(1);
      const aggregateDirectory = stdout
        .match(/Scenario Sandbox: (.+)/)?.[1]
        ?.trim();
      expect(aggregateDirectory).toBeTruthy();
      expect(
        JSON.parse(
          readFileSync(join(aggregateDirectory!, 'reliability.json'), 'utf8')
        )
      ).toMatchObject({
        outcome: 'Cancelled',
        attempts: ['Cancelled'],
        retained: true,
      });
      const events = readFileSync(
        join(aggregateDirectory!, 'events.jsonl'),
        'utf8'
      );
      expect(events).toContain('"type":"run.completed"');
      expect(events).toContain('"outcome":"Cancelled"');
      expect(events).toContain('"artifactType":"run-event-log"');
      const htmlPath = join(aggregateDirectory!, 'report.html');
      expect(existsSync(htmlPath)).toBe(true);
      const pids = JSON.parse(readFileSync(processPath, 'utf8')) as {
        worker: number;
        descendant: number;
        sandboxDirectory: string;
        foreignDirectory: string;
      };
      const attemptDirectory = join(aggregateDirectory!, 'attempt-1');
      expect(existsSync(join(attemptDirectory, 'events.jsonl'))).toBe(true);
      expect(existsSync(join(attemptDirectory, 'run-descriptor.json'))).toBe(
        true
      );
      expect(existsSync(join(attemptDirectory, 'artifacts/main.log'))).toBe(
        true
      );
      expect(existsSync(join(attemptDirectory, 'artifacts/failure.png'))).toBe(
        true
      );
      expect(existsSync(pids.sandboxDirectory)).toBe(false);
      expect(existsSync(pids.foreignDirectory)).toBe(true);
      expect(
        readFileSync(
          join(pids.foreignDirectory, 'foreign-sentinel.txt'),
          'utf8'
        )
      ).toBe('unrelated active run');
      expect(existsSync(join(pids.foreignDirectory, 'retention.json'))).toBe(
        false
      );
      expect(events).not.toContain('product-journey-foreign-active');
      const html = readFileSync(htmlPath, 'utf8');
      expect(html).not.toContain('product-journey-foreign-active');
      for (const href of [...html.matchAll(/href="([^"]+)"/g)].map(
        (match) => match[1]!
      )) {
        expect(existsSync(join(aggregateDirectory!, href))).toBe(true);
      }
      expect(() => process.kill(pids.worker, 0)).toThrow();
      expect(() => process.kill(pids.descendant, 0)).toThrow();
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  test('does not adopt a foreign sandbox when owned cancellation evidence is unavailable', async () => {
    if (process.platform === 'win32') return;
    const root = mkdtempSync(join(tmpdir(), 'ogi-reliable-unowned-cancel-'));
    const runnerPath = join(root, 'attempt-runner.ts');
    const processPath = join(root, 'worker-started.json');
    writeFileSync(
      runnerPath,
      `import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const root = process.env.OGI_E2E_RUN_ROOT!;
const foreignDirectory = join(root, 'product-journey-foreign-only');
mkdirSync(foreignDirectory);
writeFileSync(join(foreignDirectory, 'foreign-sentinel.txt'), 'must remain foreign');
writeFileSync(${JSON.stringify(processPath)}, JSON.stringify({ worker: process.pid, foreignDirectory }));
await Bun.sleep(30_000);
`
    );
    const child = spawn(
      process.execPath,
      [join(import.meta.dir, '../src/run-reliable-packaged-handoff.ts')],
      {
        env: {
          ...process.env,
          OGI_E2E_RUN_ROOT: root,
          OGI_PACKAGED_ATTEMPT_RUNNER: runnerPath,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    let stdout = '';
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });

    try {
      const deadline = Date.now() + 3_000;
      while (!existsSync(processPath) && Date.now() < deadline) {
        await Bun.sleep(25);
      }
      expect(existsSync(processPath)).toBe(true);
      child.kill('SIGTERM');
      const status = await new Promise<number | null>((resolveExit) =>
        child.once('exit', resolveExit)
      );
      expect(status).toBe(1);
      const aggregateDirectory = stdout
        .match(/Scenario Sandbox: (.+)/)?.[1]
        ?.trim();
      expect(aggregateDirectory).toBeTruthy();
      const report = JSON.parse(
        readFileSync(join(aggregateDirectory!, 'reliability.json'), 'utf8')
      );
      expect(report).toMatchObject({
        outcome: 'Infrastructure Failed',
        attempts: ['Infrastructure Failed'],
      });
      expect(report.infrastructureDetail).toContain(
        'Owned Product Journey attempt 1 sandbox was not established'
      );
      const worker = JSON.parse(readFileSync(processPath, 'utf8')) as {
        worker: number;
        foreignDirectory: string;
      };
      expect(existsSync(worker.foreignDirectory)).toBe(true);
      expect(
        readFileSync(
          join(worker.foreignDirectory, 'foreign-sentinel.txt'),
          'utf8'
        )
      ).toBe('must remain foreign');
      expect(
        readFileSync(join(aggregateDirectory!, 'events.jsonl'), 'utf8')
      ).not.toContain('product-journey-foreign-only');
      expect(() => process.kill(worker.worker, 0)).toThrow();
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  test.each([
    'owned-path-symlink',
    'nested-artifact-symlink',
  ] as const)('rejects %s substitution without touching or linking foreign evidence', async (mode) => {
    if (process.platform === 'win32') return;
    const root = mkdtempSync(join(tmpdir(), `ogi-reliable-${mode}-`));
    const runnerPath = join(root, 'attempt-runner.ts');
    const processPath = join(root, 'worker-started.json');
    writeFileSync(
      runnerPath,
      `import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const root = process.env.OGI_E2E_RUN_ROOT!;
const mode = process.env.OGI_STUB_SYMLINK_MODE!;
const sandboxDirectory = process.env.OGI_PACKAGED_ATTEMPT_SANDBOX!;
const token = process.env.OGI_PACKAGED_ATTEMPT_OWNERSHIP_TOKEN!;
const foreignDirectory = join(root, 'foreign-evidence-target');
mkdirSync(foreignDirectory);
writeFileSync(join(foreignDirectory, 'foreign-sentinel.log'), 'foreign evidence must remain untouched');
if (mode === 'owned-path-symlink') {
  writeFileSync(join(foreignDirectory, '.ogi-attempt-owner.json'), JSON.stringify({ version: 1, token, sandboxDirectory }), { mode: 0o400 });
  symlinkSync(foreignDirectory, sandboxDirectory, 'dir');
} else {
  mkdirSync(join(sandboxDirectory, 'artifacts'), { recursive: true });
  writeFileSync(join(sandboxDirectory, '.ogi-attempt-owner.json'), JSON.stringify({ version: 1, token, sandboxDirectory }), { mode: 0o400 });
  writeFileSync(join(sandboxDirectory, 'events.jsonl'), '');
  symlinkSync(foreignDirectory, join(sandboxDirectory, 'artifacts/linked-foreign'), 'dir');
}
writeFileSync(${JSON.stringify(processPath)}, JSON.stringify({ worker: process.pid, sandboxDirectory, foreignDirectory }));
await Bun.sleep(30_000);
`
    );
    const child = spawn(
      process.execPath,
      [join(import.meta.dir, '../src/run-reliable-packaged-handoff.ts')],
      {
        env: {
          ...process.env,
          OGI_E2E_RUN_ROOT: root,
          OGI_PACKAGED_ATTEMPT_RUNNER: runnerPath,
          OGI_STUB_SYMLINK_MODE: mode,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    let stdout = '';
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });

    try {
      const deadline = Date.now() + 3_000;
      while (!existsSync(processPath) && Date.now() < deadline) {
        await Bun.sleep(25);
      }
      expect(existsSync(processPath)).toBe(true);
      child.kill('SIGTERM');
      const status = await new Promise<number | null>((resolveExit) =>
        child.once('exit', resolveExit)
      );
      expect(status).toBe(1);
      const aggregateDirectory = stdout
        .match(/Scenario Sandbox: (.+)/)?.[1]
        ?.trim();
      expect(aggregateDirectory).toBeTruthy();
      const report = JSON.parse(
        readFileSync(join(aggregateDirectory!, 'reliability.json'), 'utf8')
      );
      expect(report).toMatchObject({
        outcome: 'Infrastructure Failed',
        attempts: ['Infrastructure Failed'],
      });
      expect(report.infrastructureDetail).toMatch(
        /symbolic link|reparse point/i
      );
      const worker = JSON.parse(readFileSync(processPath, 'utf8')) as {
        worker: number;
        sandboxDirectory: string;
        foreignDirectory: string;
      };
      expect(existsSync(worker.sandboxDirectory)).toBe(false);
      expect(existsSync(worker.foreignDirectory)).toBe(true);
      expect(
        readFileSync(
          join(worker.foreignDirectory, 'foreign-sentinel.log'),
          'utf8'
        )
      ).toBe('foreign evidence must remain untouched');
      const events = readFileSync(
        join(aggregateDirectory!, 'events.jsonl'),
        'utf8'
      );
      expect(events).not.toContain('foreign-sentinel.log');
      expect(() => process.kill(worker.worker, 0)).toThrow();
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  test('packages and exposes the complete shared production coordinator contract', async () => {
    const coordinator = await import(
      '../../updater/src/production-update-coordinator.mjs'
    );
    expect(coordinator.PRODUCTION_UPDATE_COORDINATOR_MARKER).toBe(
      'ogi-production-update-coordinator-v2'
    );
    expect(typeof coordinator.installPreparedProductionUpdate).toBe('function');
    expect(typeof coordinator.recoverInterruptedProductionUpdate).toBe(
      'function'
    );
    expect(typeof coordinator.stopOwnedProcess).toBe('function');
    expect(typeof coordinator.writeTransactionJournal).toBe('function');
  });

  test('executes packaged coordinator journal crash and conservative corruption recovery paths', async () => {
    const root = mkdtempSync(
      join(import.meta.dir, 'packaged-coordinator-runtime-')
    );
    const support = join(root, 'support');
    mkdirSync(support);
    const coordinatorPath = join(support, 'production-update-coordinator.mjs');
    writeFileSync(
      coordinatorPath,
      readFileSync(
        join(
          import.meta.dir,
          '../../updater/src/production-update-coordinator.mjs'
        )
      )
    );
    const updateEnginePath = join(support, 'update-engine.mjs');
    writeFileSync(
      updateEnginePath,
      readFileSync(join(import.meta.dir, '../../updater/src/update-engine.mjs'))
    );
    writeFileSync(
      join(support, 'windows-job-evidence.mjs'),
      readFileSync(
        join(import.meta.dir, '../../updater/src/windows-job-evidence.mjs')
      )
    );
    const engine = await import(`${updateEnginePath}?runtime=${Date.now()}`);
    const coordinator = await import(
      `${coordinatorPath}?runtime=${Date.now()}`
    );
    const journalPath = join(root, 'transaction.json');
    const journal: any = {
      version: 2,
      transactionId: '12345678-1234-4234-8234-123456789abc',
      transactionToken: 'packaged-runtime-token-123456',
      phase: 'prepared',
      previousVersion: 'v1',
      targetVersion: 'v2',
      workingPath: join(root, 'working'),
      candidatePath: join(root, 'candidate'),
      backupPath: join(root, 'backup'),
      retiredBackupPath: join(root, 'retired'),
      createdAt: new Date().toISOString(),
    };
    try {
      writeFileSync(journal.workingPath, 'healthy-working');
      writeFileSync(journal.candidatePath, 'candidate');
      journal.backupManifest = engine.createInstallationManifest(
        journal.workingPath
      );
      journal.candidateManifest = engine.createInstallationManifest(
        journal.candidatePath
      );
      coordinator.writeTransactionJournal({
        journalPath,
        stateRoot: root,
        journal,
      });
      for (const stage of [
        'after-temp-write',
        'after-file-fsync',
        'after-rename',
        'after-dir-fsync',
      ]) {
        expect(() =>
          coordinator.writeTransactionJournal({
            journalPath,
            stateRoot: root,
            journal: { ...journal, phase: 'candidate-active' },
            fault: (point: string) => {
              if (point === stage) throw new Error(`packaged crash ${stage}`);
            },
          })
        ).toThrow(`packaged crash ${stage}`);
        expect(
          coordinator.readValidatedTransactionJournal({
            journalPath,
            stateRoot: root,
            expectedPaths: journal,
          }).journal?.transactionId
        ).toBe(journal.transactionId);
      }

      coordinator.writeTransactionJournal({
        journalPath,
        stateRoot: root,
        journal: { ...journal, phase: 'prepared' },
      });
      const preparedRecovery =
        await coordinator.recoverInterruptedProductionUpdate({
          paths: {
            stateRoot: root,
            workingPath: journal.workingPath,
            backupPath: journal.backupPath,
            retiredBackupPath: journal.retiredBackupPath,
            journalPath,
          },
          readProcessIdentity: async () => null,
          signalProcess: async () => {
            throw new Error('prepared recovery must not signal');
          },
          processIsAlive: async () => false,
        });
      expect(preparedRecovery.preparedDiscarded).toBe(true);
      expect(readFileSync(journal.workingPath, 'utf8')).toBe('healthy-working');
      expect(existsSync(journal.candidatePath)).toBe(false);

      writeFileSync(journal.backupPath, 'immutable-backup');
      writeFileSync(journalPath, '{"truncated":');
      writeFileSync(`${journalPath}.last-known-good`, 'not-json');
      await expect(
        coordinator.recoverInterruptedProductionUpdate({
          paths: {
            stateRoot: root,
            workingPath: journal.workingPath,
            backupPath: journal.backupPath,
            retiredBackupPath: journal.retiredBackupPath,
            journalPath,
          },
          readProcessIdentity: async () => null,
          signalProcess: async () => {
            throw new Error('must not signal without ownership evidence');
          },
          processIsAlive: async () => false,
        })
      ).rejects.toThrow('preserving transaction backups');
      expect(readFileSync(journal.workingPath, 'utf8')).toBe('healthy-working');
      expect(readFileSync(journal.backupPath, 'utf8')).toBe('immutable-backup');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('requires exact Windows launcher naming in artifacts and Run Descriptors', () => {
    const descriptor = createPackagedHandoffSandbox(
      'windows-launcher-descriptor',
      'win32'
    );
    expect(descriptor.applicationLauncherPath).toBe(
      join(descriptor.installationDirectory, 'OpenGameInstaller.exe')
    );
    const { descriptorPath: _descriptorPath, ...value } = descriptor;
    expect(() =>
      parsePackagedHandoffRunDescriptor({
        ...value,
        applicationLauncherPath: join(
          descriptor.installationDirectory,
          'OpenGameInstaller.cmd'
        ),
      })
    ).toThrow('does not match the platform launcher');
  });

  test('statically rejects Windows junction and reparse evidence paths', () => {
    const source = readFileSync(
      join(import.meta.dir, '../src/run-reliable-packaged-handoff.ts'),
      'utf8'
    );
    expect(source).toContain('lstatSync');
    expect(source).toContain('realpathSync');
    expect(source).toContain('isSymbolicLink()');
    expect(source).toContain('symbolic link or reparse point');
    expect(source).toContain('OGI_PACKAGED_ATTEMPT_OWNERSHIP_TOKEN');
  });
});
