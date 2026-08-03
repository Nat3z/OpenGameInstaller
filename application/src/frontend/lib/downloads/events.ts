import { DownloadError, formatError } from '@ogi/errors';
import { Effect } from 'effect';
import type { DownloadStatusAndInfo } from '@/frontend/store.svelte';
import type { DownloadHandshakeResult } from '@/lib/download-handshake';

export function cardStatusFromHandshake(
  handshake: DownloadHandshakeResult
): DownloadStatusAndInfo['status'] {
  switch (handshake.status) {
    case 'error':
      return 'error';
    case 'completed':
      return 'completed';
    case 'seeding':
      return 'seeding';
    default:
      return 'downloading';
  }
}

export function replayDownloadEvents(id: string) {
  return Effect.tryPromise({
    try: () => window.electronAPI.download.consumeReplayEvents(id),
    catch: (cause) =>
      new DownloadError({
        message: `Failed to replay download events: ${formatError(cause)}`,
        downloadId: id,
        cause,
      }),
  }).pipe(
    Effect.tap((events) =>
      Effect.sync(() => {
        for (const event of events) {
          document.dispatchEvent(
            new CustomEvent(event.channel, { detail: event.data })
          );
        }
      })
    ),
    Effect.asVoid
  );
}

export const finalizeDownloadCard = replayDownloadEvents;
