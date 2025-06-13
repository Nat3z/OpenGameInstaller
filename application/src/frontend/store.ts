import type { SearchResult } from 'ogi-addon'
import { writable, type Writable } from 'svelte/store'

export type DownloadStatusAndInfo = SearchResult & {
  id: string;
  status: 'downloading' | 'paused' | 'completed' | 'error' | 'setup-complete' | 'rd-downloading' | 'seeding' | 'requesting';
  progress: number;
  usedRealDebrid: boolean;
  downloadPath: string;
  downloadSpeed: number;
  downloadSize: number;
  addonSource: string;
  ratio?: number;
  part?: number;
  totalParts?: number;
}

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
  type: 'setup' | 'download' | 'configure' | 'addon-install' | 'addon-update' | 'cleanup' | 'other';
}

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
}

export interface Notification {
  message: string;
  id: string;
  type: 'info' | 'error' | 'success' | 'warning';
}
export const currentDownloads: Writable<DownloadStatusAndInfo[]> = writable([])
export const failedSetups: Writable<FailedSetup[]> = writable([])
export const deferredTasks: Writable<DeferredTask[]> = writable([])
export const notifications: Writable<Notification[]> = writable([])
export const currentStorePageOpened: Writable<number | undefined> = writable()
export const currentStorePageOpenedSource: Writable<string | undefined> = writable()
export const currentStorePageOpenedStorefront: Writable<string | undefined> = writable()
export const gameFocused: Writable<number | undefined> = writable();
export const launchGameTrigger: Writable<number | undefined> = writable(undefined)
export const gamesLaunched: Writable<Record<string, 'launched' | 'error'>> = writable({})
export type Views = "gameInstall" | "config" | "clientoptions" | "downloader" | "library" | "tasks";
export const selectedView: Writable<Views> = writable("library");

export const viewOpenedWhenChanged: Writable<Views | undefined>  = writable(undefined);
export const addonUpdates: Writable<string[]> = writable([])
export function createNotification(notification: Notification) {
  notifications.update((n) => [...n, notification])
}