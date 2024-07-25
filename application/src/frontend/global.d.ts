/// <reference types="svelte" />


type $AddTorrentOrMagnet = import("node-real-debrid").$AddTorrentOrMagnet
type $Hosts = import("node-real-debrid").$Hosts
type $UnrestrictLink = import("node-real-debrid").$UnrestrictLink;
type $UserInfo = import("node-real-debrid").$UserInfo;
type $TorrentInfo = import("node-real-debrid").$TorrentInfo;

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
      getTorrents: () => $TorrentInfo[],
      selectTorrent: (torrent: string) => boolean,
      isTorrentReady: (id: string) => boolean,
      getTorrentInfo: (id: string) => $TorrentInfo,
      updateKey: () => boolean
    },
    ddl: {
      download: (link: string, path: string) => string
    },
    installAddons: (addons: string[]) => Promise<void>,
    restartAddonServer: () => Promise<void>,
  }
}