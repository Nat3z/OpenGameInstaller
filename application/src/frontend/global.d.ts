/// <reference types="svelte" />

type AxiosResponse = import('axios').AxiosResponse;
type AxiosRequestConfig = import('axios').AxiosRequestConfig;
type LibraryInfo = import('ogi-addon').LibraryInfo;
type $AddTorrentOrMagnet = import('real-debrid-js').$AddTorrentOrMagnet;
type $Hosts = import('real-debrid-js').$Hosts;
type $UnrestrictLink = import('real-debrid-js').$UnrestrictLink;
type $UserInfo = import('real-debrid-js').$UserInfo;
type $TorrentInfo = import('real-debrid-js').$TorrentInfo;
interface Window {
  electronAPI: {
    fs: {
      read: (path: string) => string;
      write: (path: string, data: string) => void;
      mkdir: (path: string) => void;
      exists: (path: string) => boolean;
      delete: (path: string) => void;
      showFileLoc: (path: string) => void;
      unrar: (data: {
        outputDir: string;
        rarFilePath: string;
      }) => Promise<string>;
      getFilesInDir: (path: string) => Promise<string[]>;
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
        }[]
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
      axios: (
        options: AxiosRequestConfig
      ) => Promise<{ status: number; success: boolean; data: any }>;
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
      >;
      getAllApps: () => Promise<LibraryInfo[]>;
      launchGame: (appid: string) => Promise<void>;
      removeApp: (appid: number) => Promise<void>;
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
    };
    updateAddons: () => Promise<void>;
    getVersion: () => string;
    installAddons: (addons: string[]) => Promise<void>;
    restartAddonServer: () => Promise<void>;
    cleanAddons: () => Promise<void>;
  };
}
