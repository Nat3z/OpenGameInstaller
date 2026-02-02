import { describe, expect, test } from 'bun:test';
import { getInitialDownloadSize } from '../src/frontend/lib/downloads/initialDownloadSize';

describe('getInitialDownloadSize', () => {
  test('returns sizeInBytes when present', () => {
    expect(getInitialDownloadSize({ sizeInBytes: 0 })).toBe(0);
    expect(getInitialDownloadSize({ sizeInBytes: 100 })).toBe(100);
    expect(getInitialDownloadSize({ sizeInBytes: 1024 * 1024 * 1024 })).toBe(
      1024 * 1024 * 1024
    );
  });

  test('returns 0 when sizeInBytes is absent', () => {
    expect(getInitialDownloadSize({})).toBe(0);
    expect(getInitialDownloadSize({ name: 'foo' })).toBe(0);
  });

  test('returns 0 when sizeInBytes is undefined', () => {
    expect(getInitialDownloadSize({ sizeInBytes: undefined })).toBe(0);
  });
});
