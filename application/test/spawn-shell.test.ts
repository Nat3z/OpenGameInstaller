import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { resolveSpawnInvocation } from '../src/electron/lib/spawn-shell.js';

describe('resolveSpawnInvocation', () => {
  test('leaves direct process arguments unchanged', () => {
    expect(resolveSpawnInvocation('/bin/echo', ['Game Folder'])).toEqual({
      command: '/bin/echo',
      args: ['Game Folder'],
      shell: false,
    });
  });

  if (process.platform !== 'win32') {
    test('preserves literal argument boundaries around shell operators', () => {
      const invocation = resolveSpawnInvocation('printf', [
        '%s',
        '/tmp/Game Folder/game.exe',
        '&&',
        'printf',
        '%s',
        'literal$HOME',
      ]);
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
