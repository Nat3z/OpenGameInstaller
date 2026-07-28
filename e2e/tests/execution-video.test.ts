import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  startExecutionVideo,
  stopExecutionVideo,
} from '../src/execution-video';
import { finalizeRunRetention } from '../src/run-reliability';

describe('execution video', () => {
  test.skipIf(process.platform !== 'linux')(
    'captures a non-empty playable Linux execution video',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'ogi-video-'));
      const videoPath = join(root, 'execution.webm');
      const recording = await startExecutionVideo({ path: videoPath });
      await Bun.sleep(500);
      await stopExecutionVideo(recording);

      expect(statSync(videoPath).size).toBeGreaterThan(1_024);
      const probe = spawnSync(
        'ffprobe',
        [
          '-v',
          'error',
          '-show_entries',
          'stream=codec_name',
          '-of',
          'csv=p=0',
          videoPath,
        ],
        { encoding: 'utf8' }
      );
      expect(probe.status).toBe(0);
      expect(probe.stdout.trim()).toBe('vp9');
    },
    15_000
  );

  test('discards successful unpinned videos with their sandbox', () => {
    const root = mkdtempSync(join(tmpdir(), 'ogi-video-retention-'));
    const videoPath = join(root, 'execution.webm');
    writeFileSync(videoPath, Buffer.alloc(2_048));

    expect(
      finalizeRunRetention({
        runId: 'successful-video-run',
        sandboxDirectory: root,
        outcome: 'Passed',
        videoPaths: [videoPath],
      }).retained
    ).toBe(false);
    expect(existsSync(root)).toBe(false);
  });

  test('retains failure-class videos', () => {
    const root = mkdtempSync(join(tmpdir(), 'ogi-video-retained-'));
    const videoPath = join(root, 'execution.webm');
    writeFileSync(videoPath, Buffer.alloc(2_048));

    expect(
      finalizeRunRetention({
        runId: 'failed-video-run',
        sandboxDirectory: root,
        outcome: 'Failed',
        videoPaths: [videoPath],
      }).retained
    ).toBe(true);
    expect(existsSync(videoPath)).toBe(true);
  });
});
