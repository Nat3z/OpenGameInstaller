import { createLogger, LOGGER_PREFIXES } from '@ogi/logger';
import type {
  BasicLibraryInfo,
  SearchResult,
  SetupCommandData,
} from '@ogi-sdk/connect';
import { Either, Schema } from 'effect';
import { type Writable, writable } from 'svelte/store';
import {
  assertMarketplaceUrlProtocol,
  assertNoShellInjection,
  type CommunityAddon,
  communityAddonArraySchema,
} from '@/electron/lib/marketplace-schema';
import { runFrontendEffect } from '@/frontend/lib/core/runtime';
import { electronRpc } from '@/frontend/lib/electron-rpc';

const logger = createLogger(LOGGER_PREFIXES.frontend);

export type { CommunityAddon };

export type DownloadProcessingPhase =
  | 'Merging chunks'
  | 'Moving files'
  | 'Extracting archive';

export type DownloadStatusAndInfo = SearchResult & {
  appID: number;
  id: string;
  status:
    | 'downloading'
    | 'merging'
    | 'paused'
    | 'completed'
    | 'error'
    | 'setup-complete'
    | 'rd-downloading'
    | 'seeding'
    | 'redistr-downloading'
    | 'requesting'
    | 'installing-redistributables';
  progress: number;
  processingPhase?: DownloadProcessingPhase;
  error?: string;
  usedDebridService?:
    | 'realdebrid'
    | 'alldebrid'
    | 'torbox'
    | 'premiumize'
    | 'none';
  downloadPath: string;
  files: {
    name: string;
    /** Exact resolved target path used by the download backend. */
    path?: string;
    downloadURL: string;
    headers?: Record<string, string>;
  }[];
  downloadSpeed: number;
  downloadSize: number;
  addonSource: string;
  capsuleImage: string;
  coverImage: string;
  ratio?: number;
  storefront: string;
  part?: number;
  totalParts?: number;
  queuePosition?: number;
  // Additional properties for resume functionality
  originalDownloadURL?: string;
  originalFiles?: DownloadStatusAndInfo['files'];
  pausedAt?: number;
  // Update-specific properties
  isUpdate?: boolean;
  updateVersion?: string;
  clearOldFilesBeforeUpdate?: boolean;
  // Manifest data from the search result, passed to the setup handler
  manifest?: Record<string, unknown>;
};

export type DeferredTask = {
  id: string;
  name: string;
  description: string;
  addonOwner: string;
  status: 'pending' | 'running' | 'completed' | 'error' | 'cancelled';
  progress: number;
  logs: string[];
  timestamp: number;
  duration?: number;
  error?: string;
  type:
    | 'setup'
    | 'download'
    | 'configure'
    | 'addon-install'
    | 'addon-update'
    | 'cleanup'
    | 'other';
};

export type FailedSetup = {
  id: string;
  timestamp: number;
  retryCount: number;
  downloadInfo: DownloadStatusAndInfo;
  setupData: SetupCommandData;
  error: string;
  should: 'call-addon' | 'call-unrar' | 'call-unzip';
};

export interface Notification {
  message: string;
  id: string;
  type: 'info' | 'error' | 'success' | 'warning';
  timestamp?: number;
}

// Search-related types and state
export type SearchResultWithSource = BasicLibraryInfo & { addonsource: string };

export const currentDownloads: Writable<DownloadStatusAndInfo[]> = writable([]);
export const failedSetups: Writable<FailedSetup[]> = writable([]);
export const deferredTasks: Writable<DeferredTask[]> = writable([]);
export const removedTasks: Writable<string[]> = writable([]);
export const notifications: Writable<Notification[]> = writable([]);
export const notificationHistory: Writable<Notification[]> = writable([]);
export const readNotificationIds: Writable<Set<string>> = writable(new Set());
export const showNotificationSideView: Writable<boolean> = writable(false);

// Setup logs for individual downloads
export type SetupLog = {
  downloadId: string;
  logs: string[];
  progress: number;
  isActive: boolean;
};

export const setupLogs: Writable<Record<string, SetupLog>> = writable({});

// Redistributable installation progress tracking
export type RedistributableInstall = {
  downloadId: string;
  appID: number;
  gameName: string;
  addonSource: string;
  redistributables: Array<{
    name: string;
    path: string;
    status: 'pending' | 'installing' | 'completed' | 'failed';
  }>;
  overallProgress: number;
  isComplete: boolean;
  error?: string;
};

export const redistributableInstalls: Writable<
  Record<string, RedistributableInstall>
> = writable({});

// OOBE logs for the out-of-box experience
export type OOBELog = {
  logs: string[];
  isActive: boolean;
};

export const oobeLog: Writable<OOBELog> = writable({
  logs: [],
  isActive: false,
});

export const currentStorePageOpened: Writable<number | undefined> = writable();
export const currentStorePageOpenedStorefront: Writable<string | undefined> =
  writable();
export const gameFocused: Writable<number | undefined> = writable();
/** Set by PlayPage onMount when opened from GameLaunchOverlay; overlay waits for this before firing launchGameTrigger */
export const launchOverlayPlayPageReady: Writable<number | undefined> =
  writable(undefined);
export const launchGameTrigger: Writable<number | undefined> =
  writable(undefined);
export const gamesLaunched: Writable<
  Record<string, 'launching' | 'launched' | 'error'>
> = writable({});
export type Views =
  | 'config'
  | 'clientoptions'
  | 'downloader'
  | 'discovery'
  | 'library';

export const selectedView: Writable<Views> = writable('library');

export const viewOpenedWhenChanged: Writable<Views | undefined> =
  writable(undefined);
export const addonUpdates: Writable<string[]> = writable([]);

// Search state
export type SearchResultsByAddon = {
  addonId: string;
  addonName: string;
  results: BasicLibraryInfo[];
};

export const searchResults: Writable<BasicLibraryInfo[]> = writable([]);
export const searchResultsByAddon: Writable<SearchResultsByAddon[]> = writable(
  []
);
export const searchQuery: Writable<string> = writable('');
export const loadingResults: Writable<boolean> = writable(false);
export const isOnline: Writable<boolean> = writable(true);

// Header back button state - allows any component to show a back button in the header
export type HeaderBackButton = {
  visible: boolean;
  onClick: (() => void) | null;
  ariaLabel?: string;
};

export const headerBackButton: Writable<HeaderBackButton> = writable({
  visible: false,
  onClick: null,
  ariaLabel: 'Go back',
});

export function setHeaderBackButton(onClick: () => void, ariaLabel?: string) {
  headerBackButton.set({
    visible: true,
    onClick,
    ariaLabel: ariaLabel || 'Go back',
  });
}

export function clearHeaderBackButton() {
  headerBackButton.set({
    visible: false,
    onClick: null,
    ariaLabel: 'Go back',
  });
}

export function createNotification(notification: Notification) {
  const notificationWithTimestamp = {
    ...notification,
    timestamp: notification.timestamp || Date.now(),
  };

  notifications.update((n) => [...n, notificationWithTimestamp]);
  notificationHistory.update((h) => [notificationWithTimestamp, ...h]);
}

export type QueuedModal = {
  id: string;
  preparedToOpen: boolean;
  priority: 'ui' | 'addon-ask' | 'urgent';
};

export const priorityToNumber: Record<QueuedModal['priority'], number> = {
  'addon-ask': 0,
  ui: 1,
  urgent: 2,
} as const;

export const modalQueue: Writable<QueuedModal[]> = writable([]);

export let communityAddons: { [key: string]: CommunityAddon[] } = $state({});
export const DEFAULT_MARKETPLACE_SOURCES = [
  'https://ogi-marketplace.nat3z.com',
];
export const marketplaceSources: string[] = $state([
  ...DEFAULT_MARKETPLACE_SOURCES,
]);

function normalizeMarketplaceSource(source: string) {
  return source.trim().replace(/\/+$/, '');
}

export function loadMarketplaceSources() {
  try {
    const config = JSON.parse(
      window.electronAPI.fs.read('./config/option/general.json')
    ) as { marketplaceSources?: unknown };
    const configuredSources = Array.isArray(config.marketplaceSources)
      ? config.marketplaceSources
          .filter((source): source is string => typeof source === 'string')
          .map((source) => normalizeMarketplaceSource(source))
          .filter(Boolean)
      : [];

    marketplaceSources.splice(
      0,
      marketplaceSources.length,
      ...(configuredSources.length
        ? [...new Set(configuredSources)]
        : DEFAULT_MARKETPLACE_SOURCES)
    );
  } catch (error) {
    logger.sync.error('Failed to load marketplace sources:', error);
    marketplaceSources.splice(
      0,
      marketplaceSources.length,
      ...DEFAULT_MARKETPLACE_SOURCES
    );
  }

  return marketplaceSources;
}

export function saveMarketplaceSources(sources: string[]) {
  const normalizedSources = [
    ...new Set(sources.map((source) => normalizeMarketplaceSource(source))),
  ].filter(Boolean);

  const nextSources = normalizedSources.length
    ? normalizedSources
    : [...DEFAULT_MARKETPLACE_SOURCES];

  const config = JSON.parse(
    window.electronAPI.fs.read('./config/option/general.json')
  ) as Record<string, unknown>;
  config.marketplaceSources = nextSources;
  window.electronAPI.fs.write(
    './config/option/general.json',
    JSON.stringify(config, null, 2)
  );
  marketplaceSources.splice(0, marketplaceSources.length, ...nextSources);
  return marketplaceSources;
}

export async function fetchCommunityAddons() {
  const sources = loadMarketplaceSources();
  const previousAddons = { ...communityAddons };

  await Promise.allSettled(
    sources.map(async (source) => {
      try {
        assertNoShellInjection(source, 'marketplace source URL');
        const url = source.endsWith('/api/marketplace.json')
          ? source
          : `${source}/api/marketplace.json`;
        assertMarketplaceUrlProtocol(url);
        const response = await runFrontendEffect(
          electronRpc.app.axios({
            method: 'GET',
            url,
            headers: {
              'Content-Type': 'application/json',
              'User-Agent': 'OpenGameInstaller Client/Rest1.0',
            },
          })
        );
        const parsed = Schema.decodeUnknownEither(communityAddonArraySchema)(
          response.data
        );
        if (Either.isLeft(parsed)) {
          logger.sync.error(
            'Invalid marketplace JSON for',
            source,
            parsed.left
          );
          return;
        }
        communityAddons[source] = [...parsed.right];
      } catch (error) {
        logger.sync.error('Failed to fetch marketplace for', source, error);
        if (previousAddons[source]) {
          communityAddons[source] = previousAddons[source];
        }
      }
    })
  );
}
