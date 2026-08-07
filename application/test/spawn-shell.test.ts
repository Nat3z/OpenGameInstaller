import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  inferSpawnShell,
  resolveSpawnInvocation,
} from '../src/electron/lib/spawn-shell.js';

const linuxContext = {
  platform: 'linux',
  env: { SHELL: '/bin/sh' },
} as const;

const token = (value: string, quoted: boolean) => ({ value, quoted });

describe('resolveSpawnInvocation', () => {
  test('leaves direct process arguments unchanged', () => {
    expect(resolveSpawnInvocation('/bin/echo', ['Game Folder'])).toEqual({
      command: '/bin/echo',
      args: ['Game Folder'],
      shell: false,
    });
  });

  test('does not enable a shell for a quoted wildcard', () => {
    const tokens = [token('/bin/echo', true), token('*', true)];

    expect(inferSpawnShell('/bin/echo', ['*'], tokens, linuxContext)).toBe(
      false
    );
  });

  test('preserves inline redirection as shell syntax', () => {
    const tokens = [
      token('/bin/echo', true),
      token('hello', false),
      token('2>/tmp/game.log', false),
    ];

    expect(
      resolveSpawnInvocation(
        '/bin/echo',
        ['hello', '2>/tmp/game.log'],
        tokens,
        linuxContext
      )
    ).toEqual({
      command: "'/bin/echo' 'hello' 2>/tmp/game.log",
      shell: '/bin/sh',
    });
  });

  test('invokes PowerShell scripts directly with -File', () => {
    expect(
      resolveSpawnInvocation(
        'launch.ps1',
        ['Game Folder'],
        [token('launch.ps1', true), token('Game Folder', true)],
        {
          platform: 'win32',
          env: { POWERSHELL_PATH: 'pwsh.exe' },
        }
      )
    ).toEqual({
      command: 'pwsh.exe',
      args: ['-File', 'launch.ps1', 'Game Folder'],
      shell: false,
    });
  });

  test('serializes Windows shell invocations without an argument array', () => {
    expect(
      resolveSpawnInvocation(
        'C:\\Tools\\launcher.cmd',
        ['Game Folder', '&&', 'echo', 'done'],
        [
          token('C:\\Tools\\launcher.cmd', true),
          token('Game Folder', true),
          token('&&', false),
          token('echo', false),
          token('done', false),
        ],
        { platform: 'win32', env: { ComSpec: 'cmd.exe' } }
      )
    ).toEqual({
      command: '"C:\\Tools\\launcher.cmd" "Game Folder" && "echo" "done"',
      shell: 'cmd.exe',
    });
  });

  if (process.platform !== 'win32') {
    test('preserves literal argument boundaries around shell operators', () => {
      const args = [
        '%s',
        '/tmp/Game Folder/game.exe',
        '&&',
        'printf',
        '%s',
        'literal$HOME',
      ];
      const tokens = [
        token('printf', false),
        token('%s', true),
        token('/tmp/Game Folder/game.exe', true),
        token('&&', false),
        token('printf', false),
        token('%s', true),
        token('literal$HOME', true),
      ];
      const invocation = resolveSpawnInvocation(
        'printf',
        args,
        tokens,
        linuxContext
      );
      expect(invocation.args).toBeUndefined();
      const spawnOptions = {
        encoding: 'utf8',
        shell: invocation.shell,
      } as const;
      const result = invocation.args
        ? spawnSync(invocation.command, invocation.args, spawnOptions)
        : spawnSync(invocation.command, spawnOptions);

      expect(result.status).toBe(0);
      expect(result.stdout).toBe('/tmp/Game Folder/game.exeliteral$HOME');
    });
  }
});
