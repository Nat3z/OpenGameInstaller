import { describe, expect, test } from 'bun:test';
import { getUmuRedistributableEnvironment } from '../src/electron/handlers/helpers.app/umu-environment';

describe('UMU redistributable environment', () => {
  test.each([
    'dotnet40',
    'dotnet48',
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
