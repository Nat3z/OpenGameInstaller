import { describe, expect, test } from 'bun:test';
import {
  createSingleInstanceData,
  parseLaunchRequestFromArgv,
} from '../src/electron/lib/single-instance-launch.js';

describe('single-instance Steam launch handoff', () => {
  test('uses the Steam environment from the second instance', () => {
    const secondaryData = createSingleInstanceData({
      OGI_STEAM_ENV: 'second-instance',
    });
    const payload = parseLaunchRequestFromArgv(
      [
        '/opt/OpenGameInstaller.AppImage',
        '--game-id=42',
        '--',
        '/usr/lib/steam/steam-launch-wrapper',
      ],
      secondaryData,
      { OGI_STEAM_ENV: 'primary-instance' }
    );

    expect(payload?.launchEnv).toEqual({
      OGI_STEAM_ENV: 'second-instance',
    });
  });
});
