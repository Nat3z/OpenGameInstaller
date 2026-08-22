import { describe, expect, test } from 'bun:test';
import { isNixOSCommandResult } from '../src/electron/lib/nix-detection';

describe('NixOS detection', () => {
  test('recognizes a successful nixos-rebuild lookup from stdout', () => {
    expect(
      isNixOSCommandResult(null, '/run/current-system/sw/bin/nixos-rebuild\n')
    ).toBe(true);
  });

  test('rejects failed lookups and empty stdout', () => {
    expect(isNixOSCommandResult(new Error('command not found'), '')).toBe(
      false
    );
    expect(isNixOSCommandResult(null, '')).toBe(false);
  });
});
