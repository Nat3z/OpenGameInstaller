import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProductionDurabilityAdapter } from '../../updater/src/production-update-coordinator.mjs';
import {
  clientOptionsIncludesSteamGridDb,
  oobeIncludesSteamGridDb,
} from '../accessibility-states';

const repositoryRoot = join(import.meta.dir, '../..');
const { normalizeNodeRequirePath } = require('../offline-traffic-guard.cjs');

function assertDurabilityType(adapter: ProductionDurabilityAdapter) {
  adapter.syncFile(1);
}

void assertDurabilityType;

describe('Windows platform regressions', () => {
  test('omits SteamGridDB from Windows OOBE and Client Options', () => {
    expect(oobeIncludesSteamGridDb('win32')).toBe(false);
    expect(oobeIncludesSteamGridDb('linux')).toBe(true);
    expect(oobeIncludesSteamGridDb('darwin')).toBe(true);
    expect(clientOptionsIncludesSteamGridDb('win32')).toBe(false);
    expect(clientOptionsIncludesSteamGridDb('linux')).toBe(true);
    expect(clientOptionsIncludesSteamGridDb('darwin')).toBe(false);
  });

  test('normalizes an absolute Windows preload path for NODE_OPTIONS', () => {
    expect(
      normalizeNodeRequirePath(
        'D:\\a\\OpenGameInstaller\\e2e\\offline-traffic-guard.cjs'
      )
    ).toBe('D:/a/OpenGameInstaller/e2e/offline-traffic-guard.cjs');
  });

  test('skips unsupported Windows fsync while keeping write-through renames', () => {
    const source = readFileSync(
      join(repositoryRoot, 'updater/src/production-update-coordinator.mjs'),
      'utf8'
    );
    expect(source).toContain('MOVEFILE_WRITE_THROUGH');
    expect(source).toContain('syncFile: () => {}');
    expect(source).toContain('durability.syncFile(descriptor)');
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
