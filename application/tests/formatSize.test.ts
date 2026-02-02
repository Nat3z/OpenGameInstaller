import { describe, expect, test } from 'bun:test';
import { formatSize } from '../src/frontend/lib/formatSize';

describe('formatSize', () => {
  test('formats bytes (< 1024)', () => {
    expect(formatSize(0)).toBe('0 B');
    expect(formatSize(1)).toBe('1 B');
    expect(formatSize(1023)).toBe('1023 B');
  });

  test('formats KB (1024 to 1024² - 1)', () => {
    expect(formatSize(1024)).toBe('1.00 KB');
    expect(formatSize(1025)).toBe('1.00 KB');
    expect(formatSize(1536)).toBe('1.50 KB');
    expect(formatSize(1024 * 1024 - 1)).toBe('1024.00 KB');
  });

  test('formats MB (1024² to 1024³ - 1)', () => {
    expect(formatSize(1024 * 1024)).toBe('1.00 MB');
    expect(formatSize(1024 * 1024 + 1)).toBe('1.00 MB');
    expect(formatSize(2.5 * 1024 * 1024)).toBe('2.50 MB');
    expect(formatSize(1024 * 1024 * 1024 - 1)).toBe('1024.00 MB');
  });

  test('formats GB (>= 1024³)', () => {
    expect(formatSize(1024 * 1024 * 1024)).toBe('1.00 GB');
    expect(formatSize(1024 * 1024 * 1024 + 1)).toBe('1.00 GB');
    expect(formatSize(5.5 * 1024 * 1024 * 1024)).toBe('5.50 GB');
  });
});
