import { describe, expect, test } from 'bun:test';
import { getBunSetupAction } from '../src/electron/lib/bun-setup';

describe('Bun setup', () => {
  test("uses Bun's canonical installer endpoint on Linux", () => {
    expect(
      getBunSetupAction({
        installed: false,
        isNixOS: false,
        platform: 'linux',
        username: 'test-user',
      })
    ).toEqual({
      type: 'install',
      commands: [
        'curl -fsSL https://bun.com/install | bash',
        'echo "export PATH=$PATH:/home/test-user/.bun/bin" >> ~/.bashrc',
      ],
    });
  });

  test('does not run the generic installer on NixOS', () => {
    expect(
      getBunSetupAction({
        installed: false,
        isNixOS: true,
        platform: 'linux',
        username: 'test-user',
      })
    ).toEqual({ type: 'unsupported' });
  });
});
