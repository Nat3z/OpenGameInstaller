import { describe, expect, test } from 'bun:test';
import {
  dedupeFileNames,
  getPersistedFilePaths,
  safeDownloadPath,
  sanitizePathSegment,
  urlBasename,
} from './paths';

describe('sanitizePathSegment', () => {
  test('strips path traversal and separators', () => {
    expect(sanitizePathSegment('../../etc/passwd')).toBe('passwd');
    expect(sanitizePathSegment('foo/bar\\baz')).toBe('baz');
    expect(sanitizePathSegment('..')).toBe('download');
  });

  test('replaces Windows-reserved characters', () => {
    expect(sanitizePathSegment('file:name|test?.iso')).toBe('file_name_test_.iso');
    expect(sanitizePathSegment('bad<>chars')).toBe('bad__chars');
  });

  test('handles empty and null input', () => {
    expect(sanitizePathSegment('')).toBe('download');
    expect(sanitizePathSegment(null)).toBe('download');
    expect(sanitizePathSegment(undefined)).toBe('download');
  });

  test('caps length at 255 characters', () => {
    const long = 'a'.repeat(300);
    expect(sanitizePathSegment(long).length).toBe(255);
  });
});

describe('safeDownloadPath', () => {
  test('builds sanitized folder paths with trailing slash', () => {
    expect(safeDownloadPath('./downloads', 'My Game')).toBe(
      './downloads/My Game/'
    );
    expect(safeDownloadPath('./downloads/', '../evil/name')).toBe(
      './downloads/name/'
    );
  });

  test('builds sanitized file paths without trailing slash', () => {
    expect(safeDownloadPath('./downloads', 'Game', 'setup.exe')).toBe(
      './downloads/Game/setup.exe'
    );
    expect(safeDownloadPath('./downloads', 'foo:bar', 'file|name')).toBe(
      './downloads/foo_bar/file_name'
    );
  });
});

describe('dedupeFileNames', () => {
  test('appends numeric suffixes for duplicate basenames', () => {
    expect(dedupeFileNames(['part.rar', 'part.rar', 'other.rar'])).toEqual([
      'part.rar',
      'part_2.rar',
      'other.rar',
    ]);
  });
});

describe('urlBasename', () => {
  test('extracts and sanitizes the last URL segment', () => {
    expect(urlBasename('https://cdn.example.com/files/foo%2Fbar.iso?token=1')).toBe(
      'bar.iso'
    );
  });
});

describe('getPersistedFilePaths', () => {
  test('prefers stored per-file paths for multi-part downloads', () => {
    const paths = getPersistedFilePaths({
      downloadPath: './downloads/Game/',
      files: [
        { name: 'part1.rar', path: './downloads/Game/part1.rar' },
        { name: 'part2.rar', path: './downloads/Game/part2.rar' },
      ],
    });
    expect(paths).toEqual([
      './downloads/Game/part1.rar',
      './downloads/Game/part2.rar',
    ]);
  });

  test('reconstructs paths from folder downloadPath without taking parent', () => {
    const paths = getPersistedFilePaths({
      downloadPath: './downloads/Game/',
      files: [{ name: 'setup.exe' }],
    });
    expect(paths).toEqual(['./downloads/Game/setup.exe']);
  });

  test('uses full downloadPath for single-file downloads', () => {
    const paths = getPersistedFilePaths({
      downloadPath: './downloads/Game/setup.exe',
      filename: 'setup.exe',
    });
    expect(paths).toEqual(['./downloads/Game/setup.exe']);
  });

  test('falls back to filename under folder downloadPath', () => {
    const paths = getPersistedFilePaths({
      downloadPath: './downloads/Game/',
      filename: 'archive.zip',
    });
    expect(paths).toEqual(['./downloads/Game/archive.zip']);
  });
});
