import { describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildPackagedHandoffArtifacts,
  copySyntheticOldInstallation,
  createPackagedHandoffSandbox,
  parsePackagedHandoffRunDescriptor,
  performRecoverableHandoff,
  startPackagedHandoffFixture,
  verifyProductionPackagingBoundary,
  writePackagedHandoffRunDescriptor,
} from '../src/packaged-handoff';

describe('packaged updater-to-application handoff', () => {
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
    mkdirSync(fixtureAddon);
    writeFileSync(join(fixtureAddon, 'addon.json'), '{"scripts":{}}');
    writeFileSync(join(fixtureAddon, 'main.js'), '// fixture addon\n');
    const fixtureWebSocketModule = join(source, 'ws');
    mkdirSync(fixtureWebSocketModule);
    writeFileSync(join(fixtureWebSocketModule, 'index.js'), '// ws\n');
    const output = join(source, 'builds');

    const builds = buildPackagedHandoffArtifacts({
      outputDirectory: output,
      applicationBundleDirectory: bundle,
      applicationMainPath: join(source, 'e2e-product-main.cjs'),
      fixtureServicePath: join(source, 'fixture-service.cjs'),
      descriptorValidatorPath: join(
        source,
        'packaged-handoff-run-descriptor.cjs'
      ),
      updaterBundleDirectory: updaterBundle,
      updaterPublicDirectory: updaterPublic,
      updaterMainPath: join(source, 'e2e-product-updater-main.cjs'),
      fixtureAddonDirectory: fixtureAddon,
      fixtureWebSocketModuleDirectory: fixtureWebSocketModule,
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
          'app/e2e-fixture-addon/addon.json',
          'app/e2e-fixture-addon/main.js',
          'support/fixture-service.cjs',
          'support/packaged-handoff-run-descriptor.cjs',
        ])
      );
    }
  });

  test('forwards only the Run Descriptor and retains Last Known-Good until Startup Health', async () => {
    const source = mkdtempSync(join(tmpdir(), 'ogi-handoff-health-source-'));
    const bundle = join(source, 'bundle');
    mkdirSync(join(bundle, 'renderer'), { recursive: true });
    writeFileSync(join(bundle, 'renderer', 'index.html'), '<h1>Current</h1>');
    for (const name of [
      'e2e-product-main.cjs',
      'e2e-product-updater-main.cjs',
      'fixture-service.cjs',
      'packaged-handoff-run-descriptor.cjs',
    ]) {
      writeFileSync(join(source, name), `// ${name}\n`);
    }
    const [linuxBuild] = buildPackagedHandoffArtifacts({
      outputDirectory: join(source, 'builds'),
      applicationBundleDirectory: bundle,
      applicationMainPath: join(source, 'e2e-product-main.cjs'),
      fixtureServicePath: join(source, 'fixture-service.cjs'),
      descriptorValidatorPath: join(
        source,
        'packaged-handoff-run-descriptor.cjs'
      ),
      updaterBundleDirectory: bundle,
      updaterPublicDirectory: bundle,
      updaterMainPath: join(source, 'e2e-product-updater-main.cjs'),
      fixtureAddonDirectory: bundle,
      fixtureWebSocketModuleDirectory: bundle,
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

  test('serves the packaged current application from the loopback Fixture Service', async () => {
    const source = mkdtempSync(join(tmpdir(), 'ogi-handoff-fixture-source-'));
    const bundle = join(source, 'bundle');
    mkdirSync(bundle, { recursive: true });
    writeFileSync(join(bundle, 'index.html'), '<h1>Current</h1>');
    for (const name of [
      'e2e-product-main.cjs',
      'e2e-product-updater-main.cjs',
      'fixture-service.cjs',
      'packaged-handoff-run-descriptor.cjs',
    ]) {
      writeFileSync(join(source, name), `// ${name}\n`);
    }
    const [linuxBuild] = buildPackagedHandoffArtifacts({
      outputDirectory: join(source, 'builds'),
      applicationBundleDirectory: bundle,
      applicationMainPath: join(source, 'e2e-product-main.cjs'),
      fixtureServicePath: join(source, 'fixture-service.cjs'),
      descriptorValidatorPath: join(
        source,
        'packaged-handoff-run-descriptor.cjs'
      ),
      updaterBundleDirectory: bundle,
      updaterPublicDirectory: bundle,
      updaterMainPath: join(source, 'e2e-product-updater-main.cjs'),
      fixtureAddonDirectory: bundle,
      fixtureWebSocketModuleDirectory: bundle,
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
        45679
      );
      expect(configured.releaseApiUrl).toBe(`${fixture.baseUrl}/releases`);
      expect(configured.artifactUrl).toBe(
        `${fixture.baseUrl}/artifacts/current.json`
      );
      expect(configured.automationPort).toBe(45678);
      expect(configured.clientSdkPort).toBe(45679);
      const releasesResponse = await fetch(`${fixture.baseUrl}/releases`);
      expect(await releasesResponse.json()).toEqual([
        expect.objectContaining({
          tag_name: 'v4.1.0-e2e',
          assets: [
            expect.objectContaining({
              browser_download_url: `${fixture.baseUrl}/artifacts/current.json`,
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
      const gameResponse = await fetch(
        `${fixture.baseUrl}/games/golden-journey.txt`
      );
      expect(await gameResponse.text()).toBe(
        'OpenGameInstaller Golden Journey fixture\n'
      );
      expect(readFileSync(fixture.requestLogPath, 'utf8')).toContain(
        '"path":"/games/golden-journey.txt"'
      );
    } finally {
      await fixture.close();
      rmSync(source, { recursive: true, force: true });
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
});
