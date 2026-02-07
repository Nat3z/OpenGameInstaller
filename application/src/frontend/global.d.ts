/// <reference types="svelte" />

type AxiosResponse = import('axios').AxiosResponse;
type AxiosRequestConfig = import('axios').AxiosRequestConfig;
type LibraryInfo = import('ogi-addon').LibraryInfo;
type ConfigurationFile = Record<string, any>;
type $AddTorrentOrMagnet = import('real-debrid-js').$AddTorrentOrMagnet;
type $Hosts = import('real-debrid-js').$Hosts;
type $UnrestrictLink = import('real-debrid-js').$UnrestrictLink;
type $UserInfo = import('real-debrid-js').$UserInfo;
type $TorrentInfo = import('real-debrid-js').$TorrentInfo;
type $GamepadNavigator = import('./managers/GamepadManager').GamepadNavigator;
interface Window {
  electronAPI: {
    fs: {
      read: (path: string) => string;
      write: (path: string, data: string) => void;
      mkdir: (path: string) => void;
      exists: (path: string) => boolean;
      delete: (path: string) => void;
      deleteAsync: (path: string) => Promise<void>;
      move: (data: {
        source: string;
        destination: string;
      }) => Promise<string | any>;
      showFileLoc: (path: string) => void;
      unrar: (data: {
        outputDir: string;
        rarFilePath: string;
        downloadId?: string;
      }) => Promise<string>;
      unzip: (data: {
        zipFilePath: string;
        outputDir: string;
        downloadId?: string;
      }) => Promise<string | null>;
      getFilesInDir: (path: string) => Promise<string[]>;
      stat: (path: string) => {
        isDirectory: boolean;
        isFile: boolean;
        isSymbolicLink: boolean;
        isBlockDevice: boolean;
        isCharacterDevice: boolean;
        isFIFO: boolean;
        isSocket: boolean;
      };
      dialog: {
        showOpenDialog: (
          options: Electron.OpenDialogOptions
        ) => Promise<string | undefined>;
        showSaveDialog: (
          options: Electron.SaveDialogOptions
        ) => Promise<string | undefined>;
      };
    };
    realdebrid: {
      setKey: (key: string) => Promise<boolean>;
      getUserInfo: () => Promise<$UserInfo>;
      unrestrictLink: (link: string) => Promise<$UnrestrictLink>;
      getHosts: () => Promise<$Hosts[]>;
      addMagnet: (url: string, host: $Hosts) => Promise<$AddTorrentOrMagnet>;
      addTorrent: (torrent: string) => Promise<$AddTorrentOrMagnet>;
      selectTorrent: (torrent: string) => Promise<boolean>;
      isTorrentReady: (id: string) => Promise<boolean>;
      getTorrentInfo: (id: string) => Promise<$TorrentInfo>;
      updateKey: () => Promise<boolean>;
    };
    torbox: {
      updateKey: () => Promise<boolean>;
      setKey: (key: string) => Promise<boolean>;
      addTorrent: (torrentURL: string) => Promise<boolean>;
      addMagnet: (magnetURL: string) => Promise<boolean>;
    };
    torrent: {
      downloadTorrent: (torrent: string, path: string) => Promise<string>;
      downloadMagnet: (magnet: string, path: string) => Promise<string>;
      pauseDownload: (downloadID: string) => Promise<void>;
      resumeDownload: (downloadID: string) => Promise<void>;
    };
    ddl: {
      download: (
        files: {
          link: string;
          path: string;
          headers?: Record<string, string>;
        }[],
        part?: number
      ) => Promise<string>;
      abortDownload: (downloadID: string) => Promise<void>;
      pauseDownload: (downloadID: string) => Promise<void>;
      resumeDownload: (downloadID: string) => Promise<boolean>;
    };
    queue: {
      cancel: (downloadID: string) => Promise<void>;
    };
    oobe: {
      // [ boolean, boolean ] => [ cleanInstalled, shouldRestart ]
      downloadTools: () => Promise<[boolean, boolean]>;
      setSteamGridDBKey: (key: string) => Promise<boolean>;
    };
    app: {
      close: () => Promise<void>;
      minimize: () => Promise<void>;
      axios: <T>(
        options: AxiosRequestConfig
      ) => Promise<{ status: number; success: boolean; data: T }>;
      inputSend: (id: string, data: any) => Promise<void>;
      insertApp: (
        info: LibraryInfo & {
          redistributables?: { name: string; path: string }[];
        }
      ) => Promise<
        | 'setup-failed'
        | 'setup-success'
        | 'setup-redistributables-failed'
        | 'setup-redistributables-success'
        | 'setup-prefix-required'
      >;
      getAllApps: () => Promise<LibraryInfo[]>;
      launchGame: (appid: string) => Promise<void>;
      removeApp: (appid: number) => Promise<void>;
      uninstallApp: (appid: number) => Promise<{
        success: boolean;
        error?: string;
      }>;
      getOS: () => Promise<string>;
      isOnline: () => Promise<boolean>;
      request: (
        method: string,
        params: any
      ) => Promise<{
        taskID?: string;
        data?: any;
        status?: number;
        error?: string;
      }>;
      getAddonPath: (addonID: string) => Promise<string>;
      getAddonIcon: (addonID: string) => Promise<string>;
      getLocalImage: (path: string) => Promise<string>;
      grantRootPassword: (password: string) => Promise<void>;
      openSteamKeyboard: (options: {
        previousText: string;
        title: string;
        maxChars: number;
      }) => Promise<boolean>;
      updateAppVersion: (
        appID: number,
        version: string,
        cwd: string,
        launchExecutable: string,
        launchArguments?: string,
        addonSource?: string
      ) => Promise<'success' | 'app-not-found'>;
      addToSteam: (
        appID: number,
        oldSteamAppId?: number
      ) => Promise<{
        success: boolean;
        error?: string;
      }>;
      getSteamAppId: (appID: number) => Promise<{
        success: boolean;
        appId?: number;
        error?: string;
      }>;
      killSteam: () => Promise<{
        success: boolean;
        error?: string;
      }>;
      startSteam: () => Promise<{
        success: boolean;
        error?: string;
      }>;
      launchSteamApp: (appID: number) => Promise<{
        success: boolean;
        shortcutId?: number;
        error?: string;
      }>;
      checkPrefixExists: (appID: number) => Promise<{
        exists: boolean;
        prefixPath?: string;
        error?: string;
      }>;
      installRedistributables: (
        appID: number
      ) => Promise<'success' | 'failed' | 'not-found'>;
      addToDesktop: () => Promise<{
        success: boolean;
        path?: string;
        error?: string;
      }>;
    };
    updateAddons: () => Promise<void>;
    getVersion: () => string;
    installAddons: (addons: string[]) => Promise<void>;
    restartAddonServer: () => Promise<void>;
    cleanAddons: () => Promise<void>;
    downloadTorrentInto: (link: string) => Promise<Uint8Array>;
    getTorrentHash: (torrent: string | Buffer | Uint8Array) => Promise<string>;
  };
  gamepadNavigator: $GamepadNavigator;
}
