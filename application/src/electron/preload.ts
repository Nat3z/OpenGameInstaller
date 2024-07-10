import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('electronAPI', {
  fs: {
    read: (path: string) => ipcRenderer.sendSync('fs:read', path),
    write: (path: string, data: string) => ipcRenderer.sendSync('fs:write', { path, data }),
    mkdir: (path: string) => ipcRenderer.sendSync('fs:mkdir', path),
    exists: (path: string) => ipcRenderer.sendSync('fs:exists', path)
  }
})
