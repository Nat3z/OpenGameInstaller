import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProductionDurabilityAdapter } from '../../updater/src/production-update-coordinator.mjs';
import { oobeIncludesSteamGridDb } from '../accessibility-states';

const repositoryRoot = join(import.meta.dir, '../..');
const { normalizeNodeRequirePath } = require('../offline-traffic-guard.cjs');

function assertDurabilityType(adapter: ProductionDurabilityAdapter) {
  adapter.syncFile(1);
}

void assertDurabilityType;

describe('Windows platform regressions', () => {
  test('omits SteamGridDB only from Windows OOBE', () => {
    expect(oobeIncludesSteamGridDb('win32')).toBe(false);
    expect(oobeIncludesSteamGridDb('linux')).toBe(true);
    expect(oobeIncludesSteamGridDb('darwin')).toBe(true);
  });

  test('normalizes an absolute Windows preload path for NODE_OPTIONS', () => {
    expect(
      normalizeNodeRequirePath(
        'D:\\a\\OpenGameInstaller\\e2e\\offline-traffic-guard.cjs'
      )
    ).toBe('D:/a/OpenGameInstaller/e2e/offline-traffic-guard.cjs');
  });

  test('retains bounded full-tree cleanup in the existing Job wrapper', () => {
    const source = readFileSync(
      join(repositoryRoot, 'updater/src/windows-job-wrapper.ps1'),
      'utf8'
    );
    expect(source).toContain('JobObjectLimitKillOnJobClose');
    expect(source).toContain('AssignProcessToJobObject');
    expect(source).toContain('OGI_WINDOWS_JOB_TIMEOUT_MS');
    expect(source).toContain('WaitForSingleObject(member.Value, 8000)');
    expect(source).not.toContain('AppContainer');
    expect(source).not.toContain('RSA-SHA256');
    expect(source).not.toContain('JobObjectAssociateCompletionPortInformation');
  });

  test('skips unsupported Windows fsync while keeping write-through renames', () => {
    const source = readFileSync(
      join(
        repositoryRoot,
        'updater/src/production-update-coordinator.mjs'
      ),
      'utf8'
    );
    expect(source).toContain('MOVEFILE_WRITE_THROUGH');
    expect(source).toContain('syncFile: () => {}');
    expect(source).toContain('durability.syncFile(descriptor)');
  });

  test('launches Windows packaged-journey candidates without Linux process-proof fds', () => {
    const source = readFileSync(
      join(repositoryRoot, 'updater/e2e-product-journey-main.cjs'),
      'utf8'
    );
    expect(source).toContain("process.platform === 'win32'");
    expect(source).toContain('spawn(process.execPath, electronArgs');
    expect(source).toContain("process.platform === 'linux'");
    expect(source).toContain('.ogi-process-proof-');
  });

  test('pins one supported Electron version across workspaces', () => {
    const lockfile = readFileSync(join(repositoryRoot, 'bun.lock'), 'utf8');
    expect(lockfile.match(/electron@\d+\.\d+\.\d+/g)).toEqual([
      'electron@43.1.0',
    ]);
    for (const packagePath of [
      'package.json',
      'application/package.json',
      'updater/package.json',
      'e2e/package.json',
    ]) {
      const packageJson = JSON.parse(
        readFileSync(join(repositoryRoot, packagePath), 'utf8')
      );
      expect(packageJson.devDependencies.electron).toBe('43.1.0');
    }
  });
});
