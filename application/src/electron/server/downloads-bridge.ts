import { DownloadControl, Downloads } from '@ogi-sdk/core';
import { DownloadError } from '@ogi-sdk/errors';
import { Effect, Layer } from 'effect';
import { sendIPCMessage } from '@/electron/main.js';
import {
  cancelQueuedDownload,
  hasQueueCancel,
} from '@/electron/rpc/queue-cancel.js';
import { runElectronSync } from '@/electron/runtime.js';
import { toPatch } from '@/electron/server/download-patch.js';

/**
 * The one sink for download-engine output. Every engine message is mirrored
 * into core `Downloads` (so protocol clients see it on `downloads.watch`) and
 * forwarded to the renderer's IPC channel unchanged.
 *
 * Engines call this instead of `webContents.send`, so they no longer hold a
 * window. Once the renderer reads `downloads.watch`, the IPC half is deleted.
 */
/** Past the transfer: a seeding torrent's progress must not overwrite these. */
const SETUP: ReadonlySet<string> = new Set([
  'extracting',
  'installing-redistributables',
  'error',
]);

const isTransferReport = (channel: string): boolean =>
  channel.endsWith(':download-progress');

export const emitDownload = (
  channel: string,
  data: Record<string, unknown>
): void => {
  const id = typeof data.id === 'string' ? data.id : undefined;
  const patch = id ? toPatch(channel, data) : undefined;
  if (id && patch) {
    runElectronSync(
      Effect.flatMap(Downloads, (downloads) =>
        patch === 'remove'
          ? downloads.remove(id)
          : patch === 'log'
            ? downloads.log(id, (data.log as string[]) ?? [])
            : downloads
                .get(id)
                .pipe(
                  Effect.flatMap((current) =>
                    current &&
                    SETUP.has(current.status) &&
                    isTransferReport(channel)
                      ? Effect.void
                      : downloads.report(id, patch)
                  )
                )
      )
    );
  }
  void sendIPCMessage(channel, data);
};

type EngineControl = {
  readonly pause: (id: string) => Effect.Effect<void, unknown>;
  readonly resume: (id: string) => Effect.Effect<void, unknown>;
  readonly abort: (id: string) => Effect.Effect<void, unknown>;
  readonly has: (id: string) => boolean;
};

const engines: EngineControl[] = [];

/** Engines register how to control the downloads they own. */
export const registerDownloadEngine = (engine: EngineControl): void => {
  engines.push(engine);
};

const withEngine = (
  id: string,
  run: (engine: EngineControl) => Effect.Effect<void, unknown>
): Effect.Effect<void, DownloadError> => {
  const engine = engines.find((candidate) => candidate.has(id));
  return engine
    ? run(engine).pipe(
        Effect.mapError(
          (cause) =>
            new DownloadError({
              message: `Download ${id}: ${String(cause)}`,
              downloadId: id,
              cause,
            })
        )
      )
    : Effect.fail(
        new DownloadError({ message: `No engine owns ${id}`, downloadId: id })
      );
};

/** Core's control adapter: routes to whichever engine owns the download. */
export const DownloadControlFromEngines = Layer.succeed(DownloadControl, {
  pause: (id) => withEngine(id, (engine) => engine.pause(id)),
  resume: (id) => withEngine(id, (engine) => engine.resume(id)),
  // While the queue holds an entry, cancel through it: aborting the engine
  // alone leaves the entry behind and it blocks the next download's slot.
  // The queue's handler cancels the engine too.
  cancel: (id) =>
    hasQueueCancel(id)
      ? Effect.promise(() => cancelQueuedDownload(id))
      : withEngine(id, (engine) => engine.abort(id)),
});
