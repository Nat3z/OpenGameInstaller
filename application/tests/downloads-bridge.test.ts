import { expect, test } from 'bun:test';
import { Downloads, DownloadsLive } from '@ogi-sdk/core';
import { Effect } from 'effect';
import { toPatch } from '../src/electron/server/download-patch.js';

// Engines speak IPC channels. Applying their messages in order must leave
// core with one merged record per download, the way emitDownload does.
test('engine messages become core download state', async () => {
  const messages: Array<[string, Record<string, unknown>]> = [
    [
      'ddl:addon-download-created',
      {
        id: 'd1',
        name: 'Big Game',
        appID: 9,
        addonSource: 'steam',
        totalParts: 2,
      },
    ],
    [
      'ddl:download-progress',
      {
        id: 'd1',
        progress: 0.5,
        downloadSpeed: 100,
        fileSize: 2000,
        part: 1,
        status: 'downloading',
      },
    ],
  ];

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const downloads = yield* Downloads;
      const apply = (channel: string, data: Record<string, unknown>) => {
        const patch = toPatch(channel, data);
        const id = data.id as string;
        return patch === 'remove'
          ? downloads.remove(id)
          : patch === 'log' || patch === undefined
            ? Effect.void
            : downloads.report(id, patch);
      };
      for (const [channel, data] of messages) yield* apply(channel, data);
      const afterProgress = yield* downloads.get('d1');

      yield* apply('ddl:download-paused', { id: 'd1' });
      const afterPause = (yield* downloads.get('d1'))?.status;

      yield* apply('processing:progress', { id: 'd1', progress: 0.25 });
      const afterExtract = yield* downloads.get('d1');

      yield* apply('ddl:download-cancelled', { id: 'd1' });
      const afterCancel = yield* downloads.get('d1');
      return { afterProgress, afterPause, afterExtract, afterCancel };
    }).pipe(Effect.provide(DownloadsLive))
  );

  expect(result.afterProgress).toMatchObject({
    name: 'Big Game',
    appID: 9,
    status: 'downloading',
    progress: 0.5,
    speed: 100,
    size: 2000,
    part: 1,
    totalParts: 2,
  });
  expect(result.afterPause).toBe('paused');
  // Partial reports keep what is already known.
  expect(result.afterExtract).toMatchObject({
    status: 'extracting',
    progress: 0.25,
    name: 'Big Game',
  });
  expect(result.afterCancel).toBeUndefined();
});

test('non-state channels map to nothing', () => {
  expect(toPatch('ddl:some-future-channel', { id: 'x' })).toBeUndefined();
  expect(toPatch('setup:log', { id: 'x', log: ['a'] })).toBe('log');
  expect(toPatch('torrent:download-complete', { id: 'x' })).toMatchObject({
    status: 'seeding',
  });
});
