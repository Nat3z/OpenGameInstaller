import { DownloadError, formatError } from '@ogi-sdk/errors';
import { Effect } from 'effect';
import { electronRpc } from '@/frontend/lib/electron-rpc';
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
  return electronRpc.download.consumeReplayEvents(id).pipe(
    Effect.mapError(
      (cause) =>
        new DownloadError({
          message: `Failed to replay download events: ${formatError(cause)}`,
          downloadId: id,
          cause,
        })
    ),
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
