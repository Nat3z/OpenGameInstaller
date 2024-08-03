import type { SearchResult } from 'ogi-addon'
import { writable, type Writable } from 'svelte/store'

export type DownloadStatusAndInfo = SearchResult & {
  id: string;
  status: 'downloading' | 'paused' | 'completed' | 'error' | 'setup-complete' | 'rd-downloading' | 'seeding';
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

export interface Notification {
  message: string;
  id: string;
  type: 'info' | 'error' | 'success' | 'warning';
}
export const currentDownloads: Writable<DownloadStatusAndInfo[]> = writable([])
export const notifications: Writable<Notification[]> = writable([])
export const currentStorePageOpened: Writable<number | undefined> = writable()
export const currentStorePageOpenedSource: Writable<string | undefined> = writable()
export const gameFocused: Writable<number | undefined> = writable();
export const launchGameTrigger: Writable<number | undefined> = writable(undefined)
export const gamesLaunched: Writable<Record<string, 'launched' | 'error'>> = writable({})
export type Views = "gameInstall" | "config" | "clientoptions" | "downloader" | "library";
export const selectedView: Writable<Views> = writable("library");

export const viewOpenedWhenChanged: Writable<Views | undefined>  = writable(undefined);
export const addonUpdates: Writable<string[]> = writable([])
export function createNotification(notification: Notification) {
  notifications.update((n) => [...n, notification])
}