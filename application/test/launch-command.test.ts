import { describe, expect, test } from 'bun:test';
import {
  parseLaunchArgumentTokens,
  resolveLaunchCommandTokens,
} from '../src/electron/lib/launch-command.js';

test('preserves whether launch tokens were quoted', () => {
  expect(parseLaunchArgumentTokens("'*' 2>/tmp/game.log %command%")).toEqual([
    { value: '*', quoted: true },
    { value: '2>/tmp/game.log', quoted: false },
    { value: '%command%', quoted: false },
  ]);
});

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
      tokens: [
        { value: 'open', quoted: false },
        { value: 'Ghostty', quoted: false },
        { value: '&&', quoted: false },
        { value: '/bin/umu-run', quoted: true },
        { value: '/games/game.exe', quoted: true },
        { value: '--fullscreen', quoted: false },
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
      tokens: [
        { value: '/bin/umu-run', quoted: true },
        { value: '/games/game.exe', quoted: true },
        { value: '--fullscreen', quoted: false },
      ],
    });
  });
});
