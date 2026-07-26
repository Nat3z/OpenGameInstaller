import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createElectronServiceOptions,
  resolveElectronExecutable,
} from '../electron-service-options';

const wdioConfigs = [
  'application-scenario-wdio.conf.ts',
  'product-journey-wdio.conf.ts',
  'updater-scenario-wdio.conf.ts',
  'updater-wdio.conf.ts',
  'wdio.conf.ts',
];

describe('Electron service options', () => {
  test('passes the real Electron executable and entry point explicitly', () => {
    expect(
      createElectronServiceOptions(
        'C:\\workspace\\application\\e2e-main.cjs',
        ['--disable-gpu'],
        'C:\\workspace\\e2e\\node_modules\\electron\\dist\\electron.exe'
      )
    ).toEqual({
      appBinaryPath:
        'C:\\workspace\\e2e\\node_modules\\electron\\dist\\electron.exe',
      appArgs: [
        '--app=C:\\workspace\\application\\e2e-main.cjs',
        '--disable-gpu',
      ],
    });
  });

  test('rejects command shims as Electron binaries', () => {
    expect(() =>
      resolveElectronExecutable(
        () => 'C:\\workspace\\e2e\\node_modules\\.bin\\electron.CMD'
      )
    ).toThrow('command shim');
    expect(() =>
      resolveElectronExecutable(
        () => '/workspace/e2e/node_modules/.bin/electron'
      )
    ).toThrow('command shim');
  });

  test('resolves the installed Electron package to its distribution binary', () => {
    const executable = resolveElectronExecutable();
    expect(executable).toContain(`${join('electron', 'dist')}`);
    expect(executable).not.toContain(`${join('node_modules', '.bin')}`);
  });

  test('keeps every WDIO Electron configuration on the shared binary resolver', () => {
    for (const configFile of wdioConfigs) {
      const source = readFileSync(
        join(import.meta.dir, '..', configFile),
        'utf8'
      );
      expect(source).toContain('createElectronServiceOptions');
      expect(source).not.toContain('appEntryPoint:');
    }
  });
});
