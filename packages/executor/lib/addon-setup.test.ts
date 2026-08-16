import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Addon, AddonSetup } from '@ogi-sdk/executor';
import { Effect } from 'effect';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('Addon setup scripts', () => {
  test('uses the Windows command shell for chained commands', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });

    try {
      const invocation = await Effect.runPromise(
        Addon.getScriptSpawnCommand(
          'bun install --ignore-scripts && bun --version'
        )
      );

      expect(invocation.command).toBe(
        process.env.ComSpec ?? process.env.COMSPEC ?? 'cmd.exe'
      );
      expect(invocation.args.at(-1)).toContain('&&');
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    }
  });

  test('runs chained shell commands', async () => {
    const path = mkdtempSync(join(tmpdir(), 'ogi-addon-setup-'));
    temporaryDirectories.push(path);
    await Bun.write(join(path, 'package.json'), '{"private":true}');
    const setup = new AddonSetup({
      path,
      name: 'test-addon',
      scripts: {
        run: 'bun index.ts',
        preSetup: 'bun install --ignore-scripts && bun --version',
      },
    });

    await Effect.runPromise(setup.preSetup());
  });

  test('makes bunx available when Bun is outside PATH', async () => {
    const path = mkdtempSync(join(tmpdir(), 'ogi-addon-setup-'));
    const toolsPath = mkdtempSync(join(tmpdir(), 'ogi-addon-tools-'));
    const bunPath = mkdtempSync(join(tmpdir(), 'ogi-addon-bun-'));
    temporaryDirectories.push(path, toolsPath, bunPath);
    const bunExecutable = join(bunPath, 'bun');
    symlinkSync(process.execPath, bunExecutable);
    symlinkSync(process.execPath, join(bunPath, 'bunx'));
    const whichPath = join(toolsPath, 'which');
    writeFileSync(
      whichPath,
      `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(bunExecutable)}\n`
    );
    chmodSync(whichPath, 0o755);

    const originalPath = process.env.PATH;
    process.env.PATH = toolsPath;

    try {
      expect(await Effect.runPromise(Addon.getBunPath())).toBe(bunExecutable);
      const setup = new AddonSetup({
        path,
        name: 'test-addon',
        scripts: {
          run: 'bun index.ts',
          preSetup: 'bun --version && bunx --version',
        },
      });

      await Effect.runPromise(setup.preSetup());
    } finally {
      process.env.PATH = originalPath;
    }
  });
});
