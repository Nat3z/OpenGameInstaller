import type { EventListenerTypes, SearchResult } from 'ogi-addon';
import { get, writable, type Writable } from 'svelte/store';
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
  usedDebridService?: 'realdebrid' | 'torbox' | 'premiumize' | 'none';
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

/**
 * Shows a back button in the header with the given click handler and optional aria label.
 * @param onClick - Callback when the back button is clicked
 * @param ariaLabel - Optional accessible label (defaults to "Go back")
 */
export function setHeaderBackButton(onClick: () => void, ariaLabel?: string) {
  headerBackButton.set({
    visible: true,
    onClick,
    ariaLabel: ariaLabel || 'Go back',
  });
}

/**
 * Hides the header back button and clears its click handler.
 */
export function clearHeaderBackButton() {
  headerBackButton.set({
    visible: false,
    onClick: null,
    ariaLabel: 'Go back',
  });
}

/**
 * Adds a notification to the active list and history. Assigns a timestamp if missing.
 * @param notification - The notification to add (message, id, type, optional timestamp)
 */
export function createNotification(notification: Notification) {
  const notificationWithTimestamp = {
    ...notification,
    timestamp: notification.timestamp ?? Date.now(),
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

/** Community addon entry from the remote list (name, author, source URL, image, description). */
export type CommunityAddon = {
  name: string;
  author: string;
  source: string;
  img: string;
  description: string;
};

/** Local cache of the community addons list; updated by fetchCommunityAddons. */
export const communityAddonsLocal: Writable<CommunityAddon[]> = writable([]);
/** True while the community addons list is being fetched. */
export const communityAddonsLoading: Writable<boolean> = writable(false);
/** Error message from the last failed fetch, or null when successful or not yet fetched. */
export const communityAddonsError: Writable<string | null> = writable(null);

/** Request id for in-flight guard; only the latest request's result and loading state are applied. */
let communityAddonsRequestId = 0;

/**
 * Normalizes a caught error into a user-facing message for community addon fetch failures.
 * Handles response.status (404, 5xx) with specific messages; for non-HTTP errors uses a generic message to avoid leaking internal details.
 * @param err - Thrown value from the fetch (e.g. axios error with response, or Error)
 * @returns A short, displayable string (e.g. "Community addons list not found.", "Server error. Try again later.", or a generic connection message)
 */
function communityAddonsErrorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'response' in err) {
    const res = (err as { response?: { status?: number } }).response;
    if (res?.status === 404) return 'Community addons list not found.';
    if (res?.status && res.status >= 500) return 'Server error. Try again later.';
  }
  return "Couldn't load community addons. Check your connection and try again.";
}

/**
 * Fetches the community addons list from the remote API and updates store state.
 * Sets communityAddonsLoading true at start and false in finally; clears then possibly sets communityAddonsError; on success updates communityAddonsLocal.
 * On error, leaves communityAddonsLocal unchanged so any cached/previous list can still be shown; the error message is set via communityAddonsErrorMessage.
 * Overlapping calls are ignored for store updates and loading state: only the latest request's result and loading state are applied (in-flight guard via request id).
 * The request id is monotonic and is not reset in finally by design, so stale completions never apply.
 * @returns Promise that resolves when the fetch and store updates are complete
 */
export async function fetchCommunityAddons(): Promise<void> {
  // In-flight guard: avoid overlapping requests; only one fetch runs at a time.
  if (get(communityAddonsLoading)) return;
  const requestId = ++communityAddonsRequestId;
  communityAddonsLoading.set(true);
  communityAddonsError.set(null);
  // Completion-path updates (try/catch/finally) apply only when requestId === communityAddonsRequestId so stale responses do not overwrite state.
  try {
    const response = await window.electronAPI.app.axios({
      method: 'GET',
      url: 'https://ogi.nat3z.com/api/community.json',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'OpenGameInstaller Client/Rest1.0',
      },
    });
    const data = response.data;
    if (!Array.isArray(data)) {
      throw new Error('Unexpected response format from community addons API.');
    }
    if (requestId === communityAddonsRequestId) {
      communityAddonsLocal.set(data as CommunityAddon[]);
      communityAddonsError.set(null);
    }
  } catch (err) {
    if (requestId === communityAddonsRequestId) {
      communityAddonsError.set(communityAddonsErrorMessage(err));
    }
    // Leave communityAddonsLocal unchanged so cached/previous list can still show
  } finally {
    // Token is intentionally not reset (monotonic); only the latest request's completion applies, so stale responses never match.
    if (requestId === communityAddonsRequestId) {
      communityAddonsLoading.set(false);
    }
  }
}
