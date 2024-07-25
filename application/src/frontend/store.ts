import type { SearchResult } from 'ogi-addon'
import { writable, type Writable } from 'svelte/store'

export interface DownloadStatusAndInfo extends SearchResult {
  id: string;
  status: 'downloading' | 'paused' | 'completed' | 'error' | 'setup-complete' | 'rd-downloading';
  progress: number;
  downloadPath: string;
  downloadSpeed: number;
  downloadSize: number;
  addonSource: string;
}

export interface Notification {
  message: string;
  id: string;
  type: 'info' | 'error' | 'success' | 'warning';
}
export const currentDownloads: Writable<DownloadStatusAndInfo[]> = writable([])
export const notifications: Writable<Notification[]> = writable([])