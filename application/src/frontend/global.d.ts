/// <reference types="svelte" />
type $AddTorrentOrMagnet = import("node-real-debrid").$AddTorrentOrMagnet
type $Hosts = import("node-real-debrid").$Hosts
type $UnrestrictLink = import("node-real-debrid").$UnrestrictLink;
type $UserInfo = import("node-real-debrid").$UserInfo;
interface Window {
  electronAPI: {
    fs: {
      read: (path: string) => string,
      write: (path: string, data: string) => void,
      mkdir: (path: string) => void,
      exists: (path: string) => boolean
    },
    realdebrid: {
      setKey: (key: string) => Promise<boolean>,
      getUserInfo: () => Promise<$UserInfo>,
      unrestrictLink: (link: string) => Promise<$UnrestrictLink>,
      getHosts: () => Promise<$Hosts[]>,
      addMagnet: (url: string, host: $Hosts) => Promise<$AddTorrentOrMagnet>,
      updateKey: () => Promise<boolean>
    },
    ddl: {
      download: (link: string, path: string) => Promise<string>
    }
  }
}