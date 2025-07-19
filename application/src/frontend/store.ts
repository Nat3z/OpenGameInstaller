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
    | 'requesting'
    | 'errored';
  progress: number;
  error?: string;
  usedRealDebrid: boolean;
  downloadPath: string;
  downloadSpeed: number;
  downloadSize: number;
  addonSource: string;
  coverURL?: string;
  ratio?: number;
  part?: number;
  totalParts?: number;
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
    type?: string;
    name?: string;
    usedRealDebrid?: boolean;
    multiPartFiles?: any;
    appID?: number;
    storefront?: string;
  };
  error: string;
};

export interface Notification {
  message: string;
  id: string;
  type: 'info' | 'error' | 'success' | 'warning';
}

// Search-related types and state
export type SearchResultWithSource = BasicLibraryInfo & { addonsource: string };

export const currentDownloads: Writable<DownloadStatusAndInfo[]> = writable([]);
export const failedSetups: Writable<FailedSetup[]> = writable([]);
export const deferredTasks: Writable<DeferredTask[]> = writable([]);
export const notifications: Writable<Notification[]> = writable([]);
export const currentStorePageOpened: Writable<number | undefined> = writable();
export const currentStorePageOpenedSource: Writable<string | undefined> =
  writable();
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
  | 'library'
  | 'tasks';
export const selectedView: Writable<Views> = writable('config');

export const viewOpenedWhenChanged: Writable<Views | undefined> =
  writable(undefined);
export const addonUpdates: Writable<string[]> = writable([]);

// Search state
export const searchResults: Writable<SearchResultWithSource[]> = writable([]);
export const searchQuery: Writable<string> = writable('');
export const loadingResults: Writable<boolean> = writable(false);
export const isOnline: Writable<boolean> = writable(true);

export function createNotification(notification: Notification) {
  notifications.update((n) => [...n, notification]);
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
