import { describe, expect, test } from 'bun:test';
import {
  detectUnarFromVersionOutput,
  detectUnrarTypeFromOutput,
  isSupportedArchivePath,
  parseLsarTotal,
  parseSevenZipTotal,
  parseUnrarFreeTotal,
  parseUnrarNonFreeTotal,
  parseZipInfoTotal,
} from '../src/extraction-progress';

describe('archive extraction progress parsing', () => {
  test('preserves generic 7-Zip archive support on Windows', () => {
    expect(isSupportedArchivePath('win32', 'game.7z')).toBe(true);
    expect(isSupportedArchivePath('win32', 'game.tar.gz')).toBe(true);
    expect(isSupportedArchivePath('linux', 'game.zip')).toBe(true);
    expect(isSupportedArchivePath('darwin', 'game.rar')).toBe(true);
    expect(isSupportedArchivePath('linux', 'game.7z')).toBe(false);
  });

  test('detects both Linux unrar implementations', () => {
    expect(detectUnrarTypeFromOutput('unrar-free: Archive not specified')).toBe(
      'unrar-free'
    );
    expect(detectUnrarTypeFromOutput('UNRAR 7.20 freeware')).toBe(
      'unrar-nonfree'
    );
    expect(detectUnrarTypeFromOutput('command unavailable')).toBe('unknown');
  });

  test('detects unar from both -version output shapes', () => {
    expect(detectUnarFromVersionOutput('unar v1.10.8, use unar --help')).toBe(
      true
    );
    expect(detectUnarFromVersionOutput('v1.10.8\n')).toBe(true);
    expect(detectUnarFromVersionOutput('')).toBe(false);
    expect(detectUnarFromVersionOutput('command not found')).toBe(false);
  });

  test('sums 7-Zip file sizes without counting physical archive size', () => {
    const output = `Physical Size = 120\n----------\nSize = 0\nSize = 12\nSize = 30\n`;
    expect(parseSevenZipTotal(output)).toBe(42);
  });

  test('reads ZipInfo and unrar-free summary totals', () => {
    expect(
      parseZipInfoTotal(
        '3 files, 314575152 bytes uncompressed, 370626 bytes compressed'
      )
    ).toBe(314575152);
    expect(
      parseUnrarFreeTotal(
        ' payload.bin\n  314572800 05-08-26 05:37 .....A\n----\n  2  314575152\n'
      )
    ).toBe(314575152);
  });

  test('sums nonfree technical-listing sizes', () => {
    expect(
      parseUnrarNonFreeTotal('Name: a\nSize: 12\nName: b\nSize: 30\n')
    ).toBe(42);
  });

  test('sums lsar listing sizes', () => {
    const output = [
      't.rar: RAR',
      '     Flags  File size   Ratio  Mode  Date       Time   Name',
      '     =====  ==========  =====  ====  ========== =====  ====',
      '  0. -----         500   0.0%  None  2026-08-22 06:20  a.txt',
      '  1. -----          42   0.0%  None  2026-08-22 06:20  b.txt',
      '(Flags: D=Directory, R=Resource fork, L=Link, E=Encrypted, @=Extended attributes)',
    ].join('\n');
    expect(parseLsarTotal(output)).toBe(542);
    expect(parseLsarTotal('no listing')).toBeUndefined();
  });

  test('rejects missing and unsafe totals', () => {
    expect(parseZipInfoTotal('not a ZipInfo trailer')).toBeUndefined();
    expect(parseUnrarFreeTotal('no summary')).toBeUndefined();
    expect(
      parseSevenZipTotal(`Size = ${Number.MAX_SAFE_INTEGER}\nSize = 1\n`)
    ).toBeUndefined();
  });
});
