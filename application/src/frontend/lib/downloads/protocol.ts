import type {
  Download,
  FailedSetup as WireFailedSetup,
} from '@ogi-sdk/protocol';
import { ogi } from '@/frontend/lib/core/ogi';
import type { SearchResultWithAddon } from '@/frontend/lib/tasks/runner';
import {
  createNotification,
  currentDownloads,
  type DownloadStatusAndInfo,
  failedSetups,
  setupLogs,
} from '@/frontend/store.svelte';

/**
 * The renderer's whole download layer: start a download through core, and
 * mirror `downloads.watch` into the stores the views already render. No
 * download, debrid, or setup logic lives here anymore.
 */

/** Core status → the card status the views switch on. */
const cardStatus = (download: Download): DownloadStatusAndInfo['status'] => {
  switch (download.status) {
    case 'resolving':
      return download.debrid ? 'rd-downloading' : 'requesting';
    case 'queued':
    case 'downloading':
      return 'downloading';
    case 'merging':
    case 'extracting':
      return 'merging';
    case 'setting-up':
      return 'completed';
    case 'completed':
      return 'setup-complete';
    default:
      return download.status;
  }
};

const toCard = (download: Download): DownloadStatusAndInfo =>
  ({
    id: download.id,
    name: download.name ?? 'Download',
    appID: download.appID ?? 0,
    status: cardStatus(download),
    progress: download.status === 'queued' ? 0 : download.progress,
    downloadSpeed: download.speed,
    downloadSize: download.size,
    queuePosition: download.queuePosition,
    part: download.part,
    totalParts: download.totalParts,
    ratio: download.ratio,
    error: download.error,
    processingPhase: download.phase as DownloadStatusAndInfo['processingPhase'],
    usedDebridService:
      download.debrid as DownloadStatusAndInfo['usedDebridService'],
    addonSource: download.addonSource ?? '',
    capsuleImage: download.capsuleImage ?? '',
    coverImage: download.coverImage ?? '',
    isUpdate: download.isUpdate,
    downloadPath: '',
    files: [],
    storefront: '',
    downloadType: 'direct',
  }) as DownloadStatusAndInfo;

const toFailed = (setup: WireFailedSetup) => ({
  id: setup.id,
  timestamp: setup.timestamp,
  retryCount: setup.retryCount,
  error: setup.error,
  downloadInfo: {
    id: setup.id,
    name: setup.name,
    appID: setup.appID,
    coverImage: '',
  },
});

let started = false;

/** Mirrors core's download state into the stores. Call once at startup. */
export const syncDownloads = async (): Promise<void> => {
  if (started) return;
  started = true;
  const client = await ogi();
  const cards = new Map<string, DownloadStatusAndInfo>();
  const publish = () => currentDownloads.set([...cards.values()]);

  client.downloads.watch((event) => {
    if (event._tag === 'Snapshot') {
      cards.clear();
      for (const download of event.value)
        cards.set(download.id, toCard(download));
    } else {
      const change = event.value;
      if (change._tag === 'Removed') cards.delete(change.id);
      else cards.set(change.download.id, toCard(change.download));
    }
    publish();
    // A card in setup shows its log panel.
    setupLogs.update((logs) => {
      const next = { ...logs };
      for (const card of cards.values()) {
        const active = card.status === 'completed';
        next[card.id] = {
          downloadId: card.id,
          logs: next[card.id]?.logs ?? [],
          progress: card.progress * 100,
          isActive: active,
        };
      }
      return next;
    });
  });

  client.downloads.failedSetups((event) => {
    failedSetups.set(event.value.map(toFailed) as never);
  });
};

/** Streams one download's setup log into `setupLogs` while it is shown. */
export const watchLogs = async (id: string): Promise<() => void> => {
  const client = await ogi();
  return client.downloads.logs({ id }, (event) => {
    const lines = event._tag === 'Snapshot' ? event.value : [event.value];
    setupLogs.update((logs) => {
      const current = logs[id];
      if (!current) return logs;
      const all =
        event._tag === 'Snapshot' ? [...lines] : [...current.logs, ...lines];
      return { ...logs, [id]: { ...current, logs: all.slice(-100) } };
    });
  });
};

const report = (message: string) => (error: unknown) => {
  createNotification({
    id: Math.random().toString(36).slice(2, 9),
    type: 'error',
    message: `${message}: ${error instanceof Error ? error.message : String(error)}`,
  });
};

/** Hands a search result to core. Returns once it is on the download list. */
export const startDownload = (
  result: SearchResultWithAddon,
  appID: number,
  update?: { version: string }
): Promise<string | undefined> =>
  ogi()
    .then((client) =>
      client.downloads.enqueue({
        appID,
        addonSource: result.addonSource,
        result: JSON.parse(JSON.stringify(result)),
        update,
      })
    )
    .then(({ id }) => id)
    .catch((error) => {
      report('Could not start the download')(error);
      return undefined;
    });

type ById = { readonly id: string };
const control =
  (
    action:
      | 'pause'
      | 'resume'
      | 'cancel'
      | 'clear'
      | 'retrySetup'
      | 'dismissSetup',
    message: string
  ) =>
  (id: string): Promise<void> =>
    ogi()
      .then((client) => client.downloads[action]({ id } satisfies ById))
      .catch(report(message));

export const pauseDownload = control('pause', 'Could not pause');
export const resumeDownload = control('resume', 'Could not resume');
export const cancelDownload = control('cancel', 'Could not cancel');
export const clearDownload = control('clear', 'Could not clear');
export const retrySetup = control('retrySetup', 'Could not retry the setup');
export const dismissSetup = control(
  'dismissSetup',
  'Could not remove the setup'
);
