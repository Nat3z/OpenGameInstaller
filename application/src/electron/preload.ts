import { contextBridge, ipcRenderer } from 'electron';
import type { $Hosts } from 'node-real-debrid';

contextBridge.exposeInMainWorld('electronAPI', {
  fs: {
    read: (path: string) => ipcRenderer.sendSync('fs:read', path),
    write: (path: string, data: string) => ipcRenderer.sendSync('fs:write', { path, data }),
    mkdir: (path: string) => ipcRenderer.sendSync('fs:mkdir', path),
    exists: (path: string) => ipcRenderer.sendSync('fs:exists', path),
    showFileLoc: (path: string) => ipcRenderer.sendSync('fs:show-file-loc', path),
    dialog: {
      showOpenDialog: (options: Electron.OpenDialogOptions) => ipcRenderer.invoke('fs:dialog:show-open-dialog', options),
      showSaveDialog: (options: Electron.SaveDialogOptions) => ipcRenderer.invoke('fs:dialog:show-save-dialog', options)
    }
  },
  realdebrid: {
    setKey: (key: string) => ipcRenderer.sendSync('real-debrid:set-key', key),
    getUserInfo: () => ipcRenderer.sendSync('real-debrid:get-user-info'),
    unrestrictLink: (link: string) => ipcRenderer.sendSync('real-debrid:unrestrict-link', link),
    addMagnet: (url: string, host: $Hosts) => ipcRenderer.sendSync('real-debrid:add-magnet', { url, host }),
    getHosts: () => ipcRenderer.sendSync('real-debrid:get-hosts'),
    updateKey: () => ipcRenderer.sendSync('real-debrid:update-key'),
    addTorrent: (torrent: string, host: $Hosts) => ipcRenderer.invoke('real-debrid:add-torrent', { torrent, host }),
    getTorrents: () => ipcRenderer.sendSync('real-debrid:get-torrents'),
    selectTorrent: (torrents: number[]) => ipcRenderer.sendSync('real-debrid:select-torrent', torrents),
    isTorrentReady: (id: string) => ipcRenderer.sendSync('real-debrid:is-torrent-ready', id),
    getTorrentInfo: (id: string) => ipcRenderer.sendSync('real-debrid:get-torrent-info', id)

  },
  ddl: {
    download: (link: string, path: string) => ipcRenderer.sendSync('ddl:download', { link, path })
  }
})

ipcRenderer.on('ddl:download-progress', (_, arg) => {
  document.dispatchEvent(new CustomEvent('ddl:download-progress', { detail: arg }));
})

ipcRenderer.on('ddl:download-error', (_, arg) => {
  document.dispatchEvent(new CustomEvent('ddl:download-error', { detail: arg }));
});
ipcRenderer.on('ddl:download-complete', (_, arg) => {
  document.dispatchEvent(new CustomEvent('ddl:download-complete', { detail: arg }));
});

ipcRenderer.on('notification', (_, arg) => {
  document.dispatchEvent(new CustomEvent('new-notification', { detail: arg }));
});