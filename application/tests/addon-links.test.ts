import { describe, expect, test } from 'bun:test';
import {
  normalizeAddonLink,
  parseAddonLink,
} from '../src/electron/lib/addon-links';

describe('marketplace addon refs', () => {
  test('parses an explicit branch without including it in the addon URL or name', () => {
    const link =
      'https://marketplace.example@https://github.com/example/addon.git:feature/new-api';

    expect(parseAddonLink(link)).toEqual({
      kind: 'marketplace',
      original: link,
      normalized: link,
      marketplaceUrl: 'https://marketplace.example',
      gitUrl: 'https://github.com/example/addon.git',
      explicitRef: 'feature/new-api',
      addonName: 'addon',
    });
  });

  test('parses an explicit commit hash', () => {
    const parsed = parseAddonLink(
      'https://marketplace.example@https://github.com/example/addon:abc123'
    );

    expect(parsed.kind).toBe('marketplace');
    if (parsed.kind !== 'marketplace') return;
    expect(parsed.gitUrl).toBe('https://github.com/example/addon');
    expect(parsed.explicitRef).toBe('abc123');
  });

  test('does not treat an SSH repository separator as an explicit ref', () => {
    const parsed = parseAddonLink(
      'https://marketplace.example@git@github.com:example/addon'
    );

    expect(parsed.kind).toBe('marketplace');
    if (parsed.kind !== 'marketplace') return;
    expect(parsed.gitUrl).toBe('git@github.com:example/addon');
    expect(parsed.explicitRef).toBeUndefined();
  });

  test('preserves the explicit ref while normalizing the addon link', () => {
    const link =
      'https://marketplace.example@https://github.com/example/addon:develop';

    expect(normalizeAddonLink(` ${link} `)).toBe(link);
  });
});
