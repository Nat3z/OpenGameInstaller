import { describe, expect, test } from 'bun:test';
import {
  type TorrentFileExpectation,
  waitForTorrentFiles,
} from '../src/electron/lib/torrent-files.js';

describe('torrent file readiness', () => {
  test('retries until every completed torrent file can be reopened', async () => {
    const files: TorrentFileExpectation[] = [
      { path: '/download/setup.exe', length: 10 },
      { path: '/download/MD5/QuickSFV.ini', length: 20 },
    ];
    const attempts = new Map<string, number>();

    await waitForTorrentFiles(files, {
      timeoutMs: 100,
      intervalMs: 0,
      probe: async (file: TorrentFileExpectation): Promise<void> => {
        const attempt = (attempts.get(file.path) ?? 0) + 1;
        attempts.set(file.path, attempt);
        if (file.path.endsWith('QuickSFV.ini') && attempt === 1) {
          throw new Error('ENOENT');
        }
      },
    });

    expect(attempts.get('/download/setup.exe')).toBe(2);
    expect(attempts.get('/download/MD5/QuickSFV.ini')).toBe(2);
  });
});
