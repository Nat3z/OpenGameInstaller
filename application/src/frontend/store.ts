import type { SearchResult } from 'ogi-addon'
import { writable, type Writable } from 'svelte/store'

export type DownloadStatusAndInfo = SearchResult & {
  id: string;
  status: 'downloading' | 'paused' | 'completed' | 'error' | 'setup-complete' | 'rd-downloading' | 'seeding';
  progress: number;
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

export function createNotification(notification: Notification) {
  notifications.update((n) => [...n, notification])
}