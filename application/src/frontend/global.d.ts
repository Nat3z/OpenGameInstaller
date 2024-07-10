/// <reference types="svelte" />
type $AddTorrentOrMagnet = import("node-real-debrid").$AddTorrentOrMagnet
type $Hosts = import("node-real-debrid").$Hosts

interface Window {
  electronAPI: {
    fs: {
      read: (path: string) => string,
      write: (path: string, data: string) => void,
      mkdir: (path: string) => void,
      exists: (path: string) => boolean
    },
    realdebrid: {
      setKey: (key: string) => void,
      getUserInfo: () => any,
      unrestrictLink: (link: string) => any,
      getHosts: () => $Hosts[],
      addMagnet: (url: string, host: $Hosts) => $AddTorrentOrMagnet,
      updateKey: () => "success" | "error"
    },
    ddl: {
      download: (link: string, path: string) => string
    }
  }
}