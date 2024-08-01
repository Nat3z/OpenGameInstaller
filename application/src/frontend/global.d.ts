/// <reference types="svelte" />

type AxiosResponse = import("axios").AxiosResponse
type AxiosRequestConfig = import("axios").AxiosRequestConfig
type $AddTorrentOrMagnet = import("real-debrid-js").$AddTorrentOrMagnet
type $Hosts = import("real-debrid-js").$Hosts
type $UnrestrictLink = import("real-debrid-js").$UnrestrictLink;
type $UserInfo = import("real-debrid-js").$UserInfo;
type $TorrentInfo = import("real-debrid-js").$TorrentInfo;

interface Window {
  electronAPI: {
    fs: {
      read: (path: string) => string,
      write: (path: string, data: string) => void,
      mkdir: (path: string) => void,
      exists: (path: string) => boolean,
      showFileLoc: (path: string) => void,
      unrar: (data: { outputDir: string, rarFilePath: string }) => Promise<string>,
      getFilesInDir: (path: string) => Promise<string[]>,
      dialog: {
        showOpenDialog: (options: Electron.OpenDialogOptions) => Promise<string | undefined>,
        showSaveDialog: (options: Electron.SaveDialogOptions) => Promise<string | undefined>
      }
    },
    realdebrid: {
      setKey: (key: string) => Promise<boolean>,
      getUserInfo: () => Promise<$UserInfo>,
      unrestrictLink: (link: string) => Promise<$UnrestrictLink>,
      getHosts: () => Promise<$Hosts[]>,
      addMagnet: (url: string, host: $Hosts) => Promise<$AddTorrentOrMagnet>,
      addTorrent: (torrent: string) => Promise<$AddTorrentOrMagnet>,
      selectTorrent: (torrent: string) => Promise<boolean>,
      isTorrentReady: (id: string) => Promise<boolean>,
      getTorrentInfo: (id: string) => Promise<$TorrentInfo>,
      updateKey: () => Promise<boolean>
    },
    torrent: {
      downloadTorrent: (torrent: string, path: string) => Promise<string>,
      downloadMagnet: (magnet: string, path: string) => Promise<string>,
    },
    ddl: {
      download: (files: { link: string, path: string }[]) => Promise<string>
    },
    oobe: {
      downloadTools: () => Promise<boolean>,
    },
    app: {
      close: () => Promise<void>,
      minimize: () => Promise<void>,
      axios: (options: AxiosRequestConfig) => Promise<{ status: number, success: boolean, data: any }>,
      searchFor: (query: string) => Promise<{ appid: string, name: string }[]>,
      inputSend: (id: string, data: any) => Promise<void>,
    },
    updateAddons: () => Promise<void>,
    getVersion: () => string,
    installAddons: (addons: string[]) => Promise<void>,
    restartAddonServer: () => Promise<void>,
    cleanAddons: () => Promise<void>,
  }
}