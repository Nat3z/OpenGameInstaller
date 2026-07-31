import { describe, expect, test } from 'bun:test';
import {
  normalizeAddonLink,
  parseAddonLink,
  replaceAddonLink,
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

  test.each([
    {
      link: 'https://marketplace.example@git@example.com:addon.git:develop',
      gitUrl: 'git@example.com:addon.git',
      explicitRef: 'develop',
    },
    {
      link: 'https://marketplace.example@ssh://git@example.com:2222/addon.git:develop',
      gitUrl: 'ssh://git@example.com:2222/addon.git',
      explicitRef: 'develop',
    },
    {
      link: 'https://marketplace.example@https://example.com/addon.git:',
      gitUrl: 'https://example.com/addon.git:',
      explicitRef: undefined,
    },
  ])('handles ref delimiters in $link', ({ link, gitUrl, explicitRef }) => {
    const parsed = parseAddonLink(link);

    expect(parsed.kind).toBe('marketplace');
    if (parsed.kind !== 'marketplace') return;
    expect(parsed.gitUrl).toBe(gitUrl);
    expect(parsed.explicitRef).toBe(explicitRef);
  });

  test('preserves the explicit ref while normalizing the addon link', () => {
    const link =
      'https://marketplace.example@https://github.com/example/addon:develop';

    expect(normalizeAddonLink(` ${link} `)).toBe(link);
  });

  test('replaces existing registrations for the same repository', () => {
    const existing =
      'https://marketplace.example@https://github.com/example/addon';
    const replacement = `${existing}:develop`;

    expect(
      replaceAddonLink(
        [existing, replacement, 'git@https://github.com/example/other'],
        replacement
      )
    ).toEqual([replacement, 'git@https://github.com/example/other']);
    expect(replaceAddonLink([replacement], existing)).toEqual([existing]);
  });
});
