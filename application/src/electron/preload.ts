import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('electronAPI', {
  fs: {
    read: (path: string) => ipcRenderer.sendSync('fs:read', path),
    write: (path: string, data: string) => ipcRenderer.sendSync('fs:write', { path, data }),
    mkdir: (path: string) => ipcRenderer.sendSync('fs:mkdir', path),
    exists: (path: string) => ipcRenderer.sendSync('fs:exists', path)
  },
  realdebrid: {
    setKey: (key: string) => ipcRenderer.sendSync('real-debrid:set-key', key),
    getUserInfo: () => ipcRenderer.sendSync('real-debrid:get-user-info'),
    unrestrictLink: (link: string) => ipcRenderer.sendSync('real-debrid:unrestrict-link', link),
    getHosts: () => ipcRenderer.sendSync('real-debrid:get-hosts')
  },
  ddl: {
    download: (link: string, path: string) => ipcRenderer.sendSync('ddl:download', { link, path })
  }
})

ipcRenderer.on('ddl:download-progress', (event, arg) => {

})

ipcRenderer.on('ddl:download-error', (event, arg) => {

});
ipcRenderer.on('ddl:download-complete', (event, arg) => {

});