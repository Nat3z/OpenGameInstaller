import { describe, expect, test } from 'bun:test';
import {
  getUmuLaunchEnvironment,
  getUmuRedistributableEnvironment,
} from '../src/electron/handlers/helpers.app/umu-environment';

describe('UMU environment', () => {
  test('prevents Xalia from displaying dependency prompts at game launch', () => {
    const environment = getUmuLaunchEnvironment({
      baseEnvironment: { PROTON_USE_XALIA: '1', UNRELATED: 'preserved' },
      launchEnvironment: { CUSTOM_LAUNCH_VALUE: 'preserved' },
      gameId: 'umu-test',
      winePrefix: '/tmp/test-prefix',
      cwd: '/tmp/test-game',
    });

    expect(environment.PROTON_USE_XALIA).toBe('0');
    expect(environment.UNRELATED).toBe('preserved');
    expect(environment.CUSTOM_LAUNCH_VALUE).toBe('preserved');
  });

  test.each([
    'dotnet40',
    'dotnet48',
    'vcrun2022',
  ])('prevents Xalia from interrupting the %s Winetricks install', () => {
    const environment = getUmuRedistributableEnvironment({
      baseEnvironment: { PROTON_USE_XALIA: '1', UNRELATED: 'preserved' },
      gameId: 'umu-test',
      winePrefix: '/tmp/test-prefix',
      cwd: '/tmp/test-game',
    });

    expect(environment.PROTON_USE_XALIA).toBe('0');
    expect(environment.UNRELATED).toBe('preserved');
  });
});
