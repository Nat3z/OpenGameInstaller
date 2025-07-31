import type { SearchResult } from 'ogi-addon';
import { writable, type Writable } from 'svelte/store';
import type { BasicLibraryInfo } from 'ogi-addon';

export type DownloadStatusAndInfo = SearchResult & {
  appID: number;
  id: string;
  status:
    | 'downloading'
    | 'paused'
    | 'completed'
    | 'error'
    | 'setup-complete'
    | 'rd-downloading'
    | 'seeding'
    | 'redistr-downloading'
    | 'requesting';
  progress: number;
  error?: string;
  usedRealDebrid: boolean;
  downloadPath: string;
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
  setupData: {
    path: string;
    type: string;
    name: string;
    usedRealDebrid: boolean;
    multiPartFiles?: {
      name: string;
      downloadURL: string;
      headers?: Record<string, string>;
    }[];
    appID: number;
    storefront: string;
    manifest?: Record<string, unknown>;
  };
  error: string;
  should: 'call-addon' | 'call-unrar';
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
export const showNotificationSideView: Writable<boolean> = writable(false);

// Setup logs for individual downloads
export type SetupLog = {
  downloadId: string;
  logs: string[];
  progress: number;
  isActive: boolean;
};

export const setupLogs: Writable<Record<string, SetupLog>> = writable({});

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
export const searchResults: Writable<BasicLibraryInfo[]> = writable([]);
export const searchQuery: Writable<string> = writable('');
export const loadingResults: Writable<boolean> = writable(false);
export const isOnline: Writable<boolean> = writable(true);

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
      communityAddonsLocal.set(response.data);
    });
}
