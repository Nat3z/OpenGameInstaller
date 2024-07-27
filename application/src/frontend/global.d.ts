/// <reference types="svelte" />


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
      dialog: {
        showOpenDialog: (options: Electron.OpenDialogOptions) => Promise<string | undefined>,
        showSaveDialog: (options: Electron.SaveDialogOptions) => Promise<string | undefined>
      }
    },
    realdebrid: {
      setKey: (key: string) => boolean,
      getUserInfo: () => $UserInfo,
      unrestrictLink: (link: string) => $UnrestrictLink,
      getHosts: () => $Hosts[],
      addMagnet: (url: string, host: $Hosts) => $AddTorrentOrMagnet,
      addTorrent: (torrent: string) => Promise<$AddTorrentOrMagnet>,
      selectTorrent: (torrent: string) => boolean,
      isTorrentReady: (id: string) => boolean,
      getTorrentInfo: (id: string) => $TorrentInfo,
      updateKey: () => boolean
    },
    torrent: {
      downloadTorrent: (torrent: string, path: string) => Promise<string>,
      downloadMagnet: (magnet: string, path: string) => Promise<string>,
    },
    ddl: {
      download: (link: string, path: string) => string
    },
    installAddons: (addons: string[]) => Promise<void>,
    restartAddonServer: () => Promise<void>,
    cleanAddons: () => Promise<void>,
  }
}