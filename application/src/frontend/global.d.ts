/// <reference types="svelte" />
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
      getHosts: () => any
    },
    ddl: {
      download: (link: string, path: string) => string
    }
  }
}