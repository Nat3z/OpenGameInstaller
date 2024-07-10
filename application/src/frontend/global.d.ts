/// <reference types="svelte" />
interface Window {
  electronAPI: {
    fs: {
      read: (path: string) => string,
      write: (path: string, data: string) => void,
      mkdir: (path: string) => void,
      exists: (path: string) => boolean
    }
  }
}