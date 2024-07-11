import type { SearchResult } from 'ogi-addon'
import { writable, type Writable } from 'svelte/store'

export interface DownloadStatusAndInfo extends SearchResult {
  id: string;
  status: 'downloading' | 'paused' | 'completed' | 'error' | 'setup-complete';
  progress: number;
  downloadPath: string;
  downloadSpeed: number;
  downloadSize: number;
  addonSource: string;
}
export const currentDownloads: Writable<DownloadStatusAndInfo[]> = writable([])