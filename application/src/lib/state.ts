// Application state persisted in the SQLite database. Shared by the main
// process (owner) and the renderer (reads through RPC, caches in memory).

export type Theme = 'light' | 'dark' | 'synthwave';
export type TorrentClient =
  | 'webtorrent'
  | 'qbittorrent'
  | 'real-debrid'
  | 'all-debrid'
  | 'torbox'
  | 'premiumize'
  | 'disable';

/** Flat, typed user settings. Keys match the settings UI option ids. */
export interface Settings {
  theme: Theme;
  fileDownloadLocation: string;
  torrentClient: TorrentClient;
  parallelChunkCount: number;
  bandwidthLimit: number;
  steamCompatibilityTool: string;
  addons: string[];
  marketplaceSources: string[];
  debridApiKey: string;
  torboxApiKey: string;
  premiumizeApiKey: string;
  alldebridApiKey: string;
  qbitHost: string;
  qbitPort: string;
  qbitUsername: string;
  qbitPassword: string;
  disableSecretCheck: boolean;
  clientSdkUrl: string;
  steamGridDbApiKey: string;
}

export const DEFAULT_MARKETPLACE_SOURCES = ['https://ogi-marketplace.nat3z.com'];

export const DEFAULT_SETTINGS: Settings = {
  theme: 'light',
  fileDownloadLocation: './downloads',
  torrentClient: 'webtorrent',
  parallelChunkCount: 8,
  bandwidthLimit: 0,
  steamCompatibilityTool: 'proton_experimental',
  addons: [],
  marketplaceSources: DEFAULT_MARKETPLACE_SOURCES,
  debridApiKey: '',
  torboxApiKey: '',
  premiumizeApiKey: '',
  alldebridApiKey: '',
  qbitHost: 'http://127.0.0.1',
  qbitPort: '8080',
  qbitUsername: 'admin',
  qbitPassword: 'admin',
  disableSecretCheck: false,
  clientSdkUrl: 'ws://127.0.0.1:7654',
  steamGridDbApiKey: '',
};

/** Installation lifecycle flags the app manages on its own behalf. */
export interface AppState {
  installed: boolean;
  /** OOBE was interrupted by a tool install that needs a restart to continue. */
  oobeRestartRequired: boolean;
  /** Version that last ran startup migrations; null until first install completes. */
  lastVersion: string | null;
}

export type AddonConfigValues = Record<string, string | number | boolean>;

export interface RequiredReadd {
  appID: number;
  steamAppId?: number;
}

export interface DismissedUpdate {
  appID: number;
  updateVersion: string;
}

export interface UpdateState {
  requiredReadds: RequiredReadd[];
  dismissedUpdates: DismissedUpdate[];
}
