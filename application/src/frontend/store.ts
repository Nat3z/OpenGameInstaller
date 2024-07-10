import type { SearchResult } from 'ogi-addon'
import { writable, type Writable } from 'svelte/store'

interface DownloadStatusAndInfo extends SearchResult {
  id: string;
  status: 'downloading' | 'paused' | 'completed' | 'error';
  progress: number;
  downloadPath: string;
  downloadSpeed: number;
}
export const currentDownloads: Writable<DownloadStatusAndInfo[]> = writable([])