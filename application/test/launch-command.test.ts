import { describe, expect, test } from 'bun:test';
import { resolveLaunchCommandTokens } from '../src/electron/lib/launch-command.js';

describe('resolveLaunchCommandTokens', () => {
  test('places a wrapped executable at the command placeholder', () => {
    expect(
      resolveLaunchCommandTokens(
        '/bin/umu-run',
        ['/games/game.exe'],
        ['open', 'Ghostty', '&&', '%command%', '--fullscreen']
      )
    ).toEqual({
      command: 'open',
      args: [
        'Ghostty',
        '&&',
        '/bin/umu-run',
        '/games/game.exe',
        '--fullscreen',
      ],
    });
  });

  test('passes arguments directly when there is no command placeholder', () => {
    expect(
      resolveLaunchCommandTokens(
        '/bin/umu-run',
        ['/games/game.exe'],
        ['--fullscreen']
      )
    ).toEqual({
      command: '/bin/umu-run',
      args: ['/games/game.exe', '--fullscreen'],
    });
  });
});
