import { type EngineOutcome, Engines } from '@ogi-sdk/core';
import { DownloadError, formatError } from '@ogi-sdk/errors';
import { Deferred, Effect, Layer } from 'effect';
import {
  type DownloadJob,
  directDownloads,
} from '@/electron/handlers/handler.ddl.js';
import {
  cancelTorrent,
  startTorrent,
} from '@/electron/handlers/handler.torrent.js';
import { runElectronEffect } from '@/electron/runtime.js';

const outcome = (
  result: 'completed' | 'failed' | 'cancelled',
  error?: string
): EngineOutcome =>
  result === 'completed'
    ? { _tag: 'Completed' }
    : result === 'failed'
      ? { _tag: 'Failed', error: error ?? 'Download failed' }
      : { _tag: 'Cancelled' };

const startFailed = (cause: unknown) =>
  new DownloadError({
    message: `Failed to start download: ${formatError(cause)}`,
    cause,
  });

/**
 * Core's engines adapter: the existing direct-download and torrent engines.
 * Both already report progress through `emitDownload`, so all this adds is
 * the "it ended" signal the pipeline waits on.
 */
export const EnginesFromHandlers = Layer.succeed(Engines, {
  direct: (files, part) =>
    Effect.gen(function* () {
      const service = directDownloads();
      if (!service)
        return yield* startFailed('the download engine is not running');
      const ended = yield* Deferred.make<EngineOutcome>();
      const handshake = yield* Effect.promise(() =>
        runElectronEffect(
          service
            .start(files as DownloadJob[], part, {
              onTerminal: (_, result, error) =>
                Deferred.unsafeDone(
                  ended,
                  Effect.succeed(outcome(result, error))
                ),
            })
            .pipe(Effect.either)
        )
      );
      if (handshake._tag === 'Left') return yield* startFailed(handshake.left);
      if (handshake.right.status === 'error')
        return yield* startFailed(handshake.right.error);
      return { id: handshake.right.id, done: Deferred.await(ended) };
    }),
  torrent: (kind, link, folder) =>
    Effect.gen(function* () {
      const ended = yield* Deferred.make<EngineOutcome>();
      const handshake = yield* Effect.promise(() =>
        runElectronEffect(
          startTorrent({
            link,
            path: folder,
            type: kind,
            onTerminal: (result, error) =>
              Deferred.unsafeDone(
                ended,
                Effect.succeed(outcome(result, error))
              ),
          }).pipe(Effect.either)
        )
      );
      if (handshake._tag === 'Left') return yield* startFailed(handshake.left);
      if (handshake.right.status === 'error')
        return yield* startFailed(handshake.right.error);
      return { id: handshake.right.id, done: Deferred.await(ended) };
    }),
  cancel: (id) =>
    directDownloads()?.has(id)
      ? (directDownloads()?.abort(id) ?? Effect.void).pipe(Effect.ignore)
      : cancelTorrent(id),
});
