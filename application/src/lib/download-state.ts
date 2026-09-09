import type { SearchResult, SetupCommandData } from '@ogi-sdk/connect';

// Download and recovery records are shared by the renderer (live state) and
// the main process (persistence), so they live outside both trees.

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
  // Raw file download enqueued by an addon via addon.download(); skips the setup phase
  isAddonDownload?: boolean;
};

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

/** A resumable download, written whenever its live state changes. */
export interface PersistedDownload {
  id: string;
  updatedAt: number;
  downloadInfo: DownloadStatusAndInfo;
  redistributableInstall?: RedistributableInstall;
}

/** A setup that failed (or was interrupted) and can be retried from disk. */
export type FailedSetup = {
  id: string;
  timestamp: number;
  retryCount: number;
  downloadInfo: DownloadStatusAndInfo;
  setupData: SetupCommandData;
  error: string;
  should: 'call-addon' | 'call-unrar' | 'call-unzip';
};
