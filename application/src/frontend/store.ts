import type { EventListenerTypes, SearchResult } from 'ogi-addon';
import { writable, type Writable } from 'svelte/store';
import type { BasicLibraryInfo } from 'ogi-addon';

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
    | 'proton-prefix-setup';
  progress: number;
  error?: string;
  usedDebridService?: 'realdebrid' | 'alldebrid' | 'torbox' | 'premiumize' | 'none';
  downloadPath: string;
  files: {
    name: string;
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
  originalFiles?: any[];
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
  failed?: string;
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
  setupData: Parameters<EventListenerTypes['setup']>[0];
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

// Proton prefix setup state for redistributable installation flow
export type ProtonPrefixSetup = {
  downloadId: string;
  appID: number;
  gameName: string;
  addonSource: string;
  redistributables: { name: string; path: string }[];
  step:
    | 'added-to-steam'
    | 'kill-steam'
    | 'start-steam'
    | 'launch-game'
    | 'waiting-prefix'
    | 'ready';
  prefixPath: string;
  prefixExists: boolean;
};

export const protonPrefixSetups: Writable<Record<string, ProtonPrefixSetup>> =
  writable({});

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
export const launchGameTrigger: Writable<number | undefined> =
  writable(undefined);
export const gamesLaunched: Writable<Record<string, 'launched' | 'error'>> =
  writable({});
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

export type CommunityAddon = {
  name: string;
  author: string;
  source: string;
  img: string;
  description: string;
};
export const communityAddonsLocal: Writable<CommunityAddon[]> = writable([]);

export async function fetchCommunityAddons() {
  window.electronAPI.app
    .axios({
      method: 'GET',
      url: 'https://ogi.nat3z.com/api/community.json',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'OpenGameInstaller Client/Rest1.0',
      },
    })
    .then((response) => {
      communityAddonsLocal.set(response.data as CommunityAddon[]);
    });
}
