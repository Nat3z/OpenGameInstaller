import type { DownloadHandshakeResult } from '@/lib/download-handshake';
import type { DownloadStatusAndInfo } from '@/frontend/store';

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

export async function replayDownloadEvents(id: string) {
  const events = await window.electronAPI.download.consumeReplayEvents(id);
  for (const event of events) {
    document.dispatchEvent(
      new CustomEvent(event.channel, { detail: event.data })
    );
  }
}

export async function finalizeDownloadCard(id: string) {
  await replayDownloadEvents(id);
}
