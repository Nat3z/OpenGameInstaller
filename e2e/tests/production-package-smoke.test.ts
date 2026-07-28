import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { productionForbiddenHookMarkers } from '../src/packaged-handoff-audit';
import {
  assertProductionTrafficAudit,
  findProductionReleaseArtifacts,
  installWindowsNsisArtifact,
  productionArtifactLaunchArguments,
  verifyExtractedProductionBoundary,
  withWindowsOutboundFirewall,
} from '../src/production-package-smoke';

function makeRoot() {
  return mkdtempSync(join(tmpdir(), 'ogi-production-smoke-test-'));
}

const require = createRequire(import.meta.url);
const { appBuilderPath } = require('app-builder-bin') as {
  appBuilderPath: string;
};

function writePublicationArtifact(
  root: string,
  name: string,
  contents: string
) {
  const artifactPath = join(root, name);
  writeFileSync(artifactPath, contents);
  const generated = spawnSync(
    appBuilderPath,
    [
      'blockmap',
      '--input',
      artifactPath,
      '--output',
      `${artifactPath}.blockmap`,
    ],
    { encoding: 'utf8' }
  );
  if (generated.status !== 0) throw new Error(generated.stderr);
  return artifactPath;
}

describe('production release artifact smoke', () => {
  test('uses production-supported non-network UI launch paths and audited traffic', () => {
    expect(productionArtifactLaunchArguments('application', 9222)).toEqual([
      '--online=false',
      '--remote-debugging-port=9222',
      '--no-first-run',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-domain-reliability',
      '--metrics-recording-only',
    ]);
    expect(productionArtifactLaunchArguments('updater', 9223)).toEqual([
      '--gui',
      '--remote-debugging-port=9223',
      '--no-first-run',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-domain-reliability',
      '--metrics-recording-only',
    ]);

    const root = makeRoot();
    const applicationLog = join(root, 'application-traffic.jsonl');
    const updaterLog = join(root, 'updater-traffic.jsonl');
    writeFileSync(
      applicationLog,
      `${JSON.stringify({ transport: 'guard-install', expected: true })}\n`
    );
    writeFileSync(
      updaterLog,
      `${JSON.stringify({ transport: 'guard-install', expected: true })}\n`
    );
    expect(
      assertProductionTrafficAudit([applicationLog, updaterLog])
    ).toHaveLength(2);
    writeFileSync(
      updaterLog,
      `${JSON.stringify({ transport: 'guard-install', expected: true })}\n${JSON.stringify({ transport: 'node-https', target: 'https://github.com/releases', expected: false })}\n`
    );
    expect(() =>
      assertProductionTrafficAudit([applicationLog, updaterLog])
    ).toThrow('unexpected public traffic');
  });

  test('installs and proves Windows outbound denial before installer execution and removes it after spawn failure', async () => {
    const root = makeRoot();
    const evidencePath = join(root, 'installer-traffic.jsonl');
    const events: string[] = [];

    await expect(
      installWindowsNsisArtifact({
        installerPath: 'C:\\release\\OpenGameInstaller-Setup.exe',
        installationDirectory: 'C:\\isolated-install',
        ruleName: 'installer-rule',
        evidencePath,
        runPowerShell(script) {
          if (script.includes('New-NetFirewallRule')) events.push('install');
          else if (script.includes('Remove-NetFirewallRule'))
            events.push('remove');
          else if (script.includes('must exist')) events.push('verify-install');
          else if (script.includes('must be absent'))
            events.push('verify-remove');
        },
        runInstaller() {
          events.push('spawn-installer');
          throw new Error('spawn ENOENT');
        },
      })
    ).rejects.toThrow('spawn ENOENT');

    expect(events).toEqual([
      'install',
      'verify-install',
      'spawn-installer',
      'remove',
      'verify-remove',
    ]);
    expect(
      readFileSync(evidencePath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line).phase)
    ).toEqual(['installed', 'action-failed', 'removed']);
    expect(() => assertProductionTrafficAudit([evidencePath])).toThrow(
      'spawn ENOENT'
    );
  });

  test('removes the Windows executable firewall rule after asynchronous spawn error', async () => {
    const root = makeRoot();
    const evidencePath = join(root, 'application-spawn-traffic.jsonl');
    const events: string[] = [];

    await expect(
      withWindowsOutboundFirewall({
        executable: 'C:\\release\\OpenGameInstaller.exe',
        ruleName: 'application-spawn-rule',
        evidencePath,
        runPowerShell(script) {
          if (script.includes('New-NetFirewallRule')) events.push('install');
          else if (script.includes('Remove-NetFirewallRule'))
            events.push('remove');
          else if (script.includes('must exist')) events.push('verify-install');
          else if (script.includes('must be absent'))
            events.push('verify-remove');
        },
        action() {
          events.push('spawn');
          return new Promise((_, reject) => {
            queueMicrotask(() => {
              events.push('spawn-error');
              reject(new Error('spawn ENOENT'));
            });
          });
        },
      })
    ).rejects.toThrow('spawn ENOENT');

    expect(events).toEqual([
      'install',
      'verify-install',
      'spawn',
      'spawn-error',
      'remove',
      'verify-remove',
    ]);
  });

  test('retains typed evidence when Windows firewall cleanup cannot be proven', async () => {
    const root = makeRoot();
    const evidencePath = join(root, 'application-traffic.jsonl');

    await expect(
      withWindowsOutboundFirewall({
        executable: 'C:\\release\\OpenGameInstaller.exe',
        ruleName: 'application-rule',
        evidencePath,
        runPowerShell(script) {
          if (script.includes('must be absent')) {
            throw new Error('firewall rule survived cleanup');
          }
        },
        action() {
          throw new Error('spawn ENOENT');
        },
      })
    ).rejects.toThrow('Windows outbound firewall lifecycle failed');

    const entries = readFileSync(evidencePath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(entries.at(-1)).toMatchObject({
      phase: 'removal-failed',
      expected: false,
    });
  });

  test('requires the exact Linux publication AppImages', () => {
    const root = makeRoot();
    writePublicationArtifact(
      root,
      'OpenGameInstaller-linux-pt.AppImage',
      'application'
    );
    writePublicationArtifact(
      root,
      'OpenGameInstaller-Setup.AppImage',
      'updater'
    );

    expect(findProductionReleaseArtifacts(root, 'linux')).toEqual({
      applicationArtifact: join(root, 'OpenGameInstaller-linux-pt.AppImage'),
      updaterArtifact: join(root, 'OpenGameInstaller-Setup.AppImage'),
      applicationBlockmap: join(
        root,
        'OpenGameInstaller-linux-pt.AppImage.blockmap'
      ),
      updaterBlockmap: join(root, 'OpenGameInstaller-Setup.AppImage.blockmap'),
      applicationKind: 'appimage',
      updaterKind: 'appimage',
    });
  });

  test('requires the exact Windows portable and installer publication artifacts', () => {
    const root = makeRoot();
    writePublicationArtifact(
      root,
      'OpenGameInstaller-Portable.zip',
      'application'
    );
    writePublicationArtifact(root, 'OpenGameInstaller-Setup.exe', 'updater');

    expect(findProductionReleaseArtifacts(root, 'win32')).toEqual({
      applicationArtifact: join(root, 'OpenGameInstaller-Portable.zip'),
      updaterArtifact: join(root, 'OpenGameInstaller-Setup.exe'),
      applicationBlockmap: join(
        root,
        'OpenGameInstaller-Portable.zip.blockmap'
      ),
      updaterBlockmap: join(root, 'OpenGameInstaller-Setup.exe.blockmap'),
      applicationKind: 'portable-zip',
      updaterKind: 'nsis-installer',
    });
  });

  test('fails missing or empty publication artifacts', () => {
    const root = makeRoot();
    writeFileSync(join(root, 'OpenGameInstaller-linux-pt.AppImage'), '');
    expect(() => findProductionReleaseArtifacts(root, 'linux')).toThrow(
      'missing or empty'
    );
  });

  test('rejects missing, corrupt, and mismatched publication blockmaps', () => {
    const missing = makeRoot();
    writeFileSync(
      join(missing, 'OpenGameInstaller-linux-pt.AppImage'),
      'application'
    );
    writePublicationArtifact(
      missing,
      'OpenGameInstaller-Setup.AppImage',
      'updater'
    );
    expect(() => findProductionReleaseArtifacts(missing, 'linux')).toThrow(
      'blockmap is missing or empty'
    );

    const corrupt = makeRoot();
    writePublicationArtifact(
      corrupt,
      'OpenGameInstaller-linux-pt.AppImage',
      'application'
    );
    writePublicationArtifact(
      corrupt,
      'OpenGameInstaller-Setup.AppImage',
      'updater'
    );
    writeFileSync(
      join(corrupt, 'OpenGameInstaller-Setup.AppImage.blockmap'),
      'not-gzip'
    );
    expect(() => findProductionReleaseArtifacts(corrupt, 'linux')).toThrow(
      'invalid blockmap'
    );

    const mismatched = makeRoot();
    writePublicationArtifact(
      mismatched,
      'OpenGameInstaller-linux-pt.AppImage',
      'application'
    );
    writePublicationArtifact(
      mismatched,
      'OpenGameInstaller-Setup.AppImage',
      'different-size'
    );
    writeFileSync(
      join(mismatched, 'OpenGameInstaller-Setup.AppImage.blockmap'),
      gzipSync(
        JSON.stringify({
          version: '2',
          files: [
            {
              name: 'file',
              offset: 0,
              checksums: ['wrong-artifact'],
              sizes: [3],
            },
          ],
        })
      )
    );
    expect(() => findProductionReleaseArtifacts(mismatched, 'linux')).toThrow(
      'does not match artifact'
    );

    const sameSizeMismatch = makeRoot();
    writePublicationArtifact(
      sameSizeMismatch,
      'OpenGameInstaller-linux-pt.AppImage',
      'application'
    );
    const changedArtifact = writePublicationArtifact(
      sameSizeMismatch,
      'OpenGameInstaller-Setup.AppImage',
      'updater'
    );
    writeFileSync(changedArtifact, 'changed');
    expect(() =>
      findProductionReleaseArtifacts(sameSizeMismatch, 'linux')
    ).toThrow('does not match artifact');
  });

  test('rejects active E2E hooks in extracted production resources', () => {
    const root = makeRoot();
    mkdirSync(join(root, 'resources', 'app'), { recursive: true });
    writeFileSync(
      join(root, 'resources', 'app', 'main.js'),
      'const descriptor = process.env.OGI_RUN_DESCRIPTOR;\n'
    );
    expect(() => verifyExtractedProductionBoundary(root)).toThrow(
      'active E2E hook'
    );
  });

  test('rejects every forbidden production hook marker', () => {
    for (const marker of productionForbiddenHookMarkers) {
      const root = makeRoot();
      mkdirSync(join(root, 'resources', 'app'), { recursive: true });
      writeFileSync(join(root, 'resources', 'app', 'main.js'), marker);
      expect(() => verifyExtractedProductionBoundary(root)).toThrow(
        'active E2E hook'
      );
    }
  });

  test('allows production Startup Health handshake identifiers', () => {
    const root = makeRoot();
    mkdirSync(join(root, 'resources', 'app'), { recursive: true });
    writeFileSync(
      join(root, 'resources', 'app', 'main.js'),
      'OGI_STARTUP_HEALTH_PATH OGI_STARTUP_HEALTH_TOKEN OGI_UPDATE_TRANSACTION_TOKEN'
    );
    expect(verifyExtractedProductionBoundary(root).activeHookMatches).toEqual(
      []
    );
  });

  test('scans packaged ASAR resources, including markers crossing stream chunks', () => {
    const root = makeRoot();
    mkdirSync(join(root, 'resources'), { recursive: true });
    writeFileSync(
      join(root, 'resources', 'app.asar'),
      `${'x'.repeat(64 * 1024 - 5)}OGI_RUN_DESCRIPTOR`
    );
    expect(() => verifyExtractedProductionBoundary(root)).toThrow(
      'active E2E hook'
    );
  });

  test('fails extracted artifacts with no packaged application resources', () => {
    const root = makeRoot();
    writeFileSync(join(root, 'binary'), 'not a packaged resource');
    expect(() => verifyExtractedProductionBoundary(root)).toThrow(
      'no scannable resources'
    );
  });

  test('accepts ordinary extracted production resources', () => {
    const root = makeRoot();
    mkdirSync(join(root, 'resources', 'app'), { recursive: true });
    writeFileSync(
      join(root, 'resources', 'app', 'main.js'),
      "console.log('production application');\n"
    );
    expect(verifyExtractedProductionBoundary(root)).toEqual({
      scannedFiles: 1,
      activeHookMatches: [],
    });
  });
});
