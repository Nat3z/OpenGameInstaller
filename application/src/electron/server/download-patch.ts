import type { DownloadPatch } from '@ogi-sdk/core';
import type { DownloadStatus } from '@ogi-sdk/protocol';

const engineStatus: Record<string, DownloadStatus> = {
  queued: 'queued',
  downloading: 'downloading',
  merging: 'merging',
  paused: 'paused',
  completed: 'completed',
  seeding: 'seeding',
  failed: 'error',
};

/** Maps an engine's IPC message to a core state change; undefined = not state. */
export const toPatch = (
  channel: string,
  data: Record<string, unknown>
): DownloadPatch | 'remove' | 'log' | undefined => {
  const num = (key: string) =>
    typeof data[key] === 'number' ? (data[key] as number) : undefined;
  switch (channel) {
    case 'ddl:download-progress':
    case 'torrent:download-progress':
      return {
        progress: num('progress'),
        speed: num('downloadSpeed'),
        size: num('fileSize'),
        queuePosition: num('queuePosition'),
        part: num('part'),
        totalParts: num('totalParts'),
        status:
          data.processingPhase === 'Merging chunks'
            ? 'merging'
            : engineStatus[String(data.status)],
      };
    case 'processing:progress':
      return {
        status: 'extracting',
        progress: num('progress'),
        speed: 0,
      };
    case 'ddl:download-paused':
    case 'torrent:download-paused':
      return { status: 'paused', speed: 0 };
    case 'ddl:download-resumed':
    case 'torrent:download-resumed':
      return { status: 'downloading' };
    case 'ddl:download-complete':
      return { status: 'completed', progress: 1, speed: 0 };
    case 'torrent:download-complete':
      return { status: 'seeding', progress: 1, speed: 0 };
    case 'ddl:download-error':
    case 'torrent:download-error':
      return {
        status: 'error',
        speed: 0,
        error: typeof data.error === 'string' ? data.error : undefined,
      };
    case 'ddl:download-cancelled':
    case 'torrent:download-cancelled':
      return 'remove';
    case 'ddl:addon-download-created':
      return {
        name: typeof data.name === 'string' ? data.name : undefined,
        appID: num('appID'),
        addonSource:
          typeof data.addonSource === 'string' ? data.addonSource : undefined,
        capsuleImage:
          typeof data.capsuleImage === 'string' ? data.capsuleImage : undefined,
        queuePosition: num('queuePosition'),
        totalParts: num('totalParts'),
      };
    case 'setup:log':
      return 'log';
    default:
      return undefined;
  }
};
