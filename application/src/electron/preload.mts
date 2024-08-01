import { AxiosRequestConfig } from 'axios';
import { contextBridge, ipcRenderer } from 'electron';
import { LibraryInfo } from 'ogi-addon';
import type { $Hosts } from 'real-debrid-js';

contextBridge.exposeInMainWorld('electronAPI', {
  fs: {
    read: (path: string) => ipcRenderer.sendSync('fs:read', path),
    write: (path: string, data: string) => ipcRenderer.sendSync('fs:write', { path, data }),
    mkdir: (path: string) => ipcRenderer.sendSync('fs:mkdir', path),
    exists: (path: string) => ipcRenderer.sendSync('fs:exists', path),
    showFileLoc: (path: string) => ipcRenderer.sendSync('fs:show-file-loc', path),
    unrar: (data: { outputDir: string, rarFilePath: string }) => ipcRenderer.invoke('fs:extract-rar', data),
    getFilesInDir: (path: string) => ipcRenderer.invoke('fs:get-files-in-dir', path),
    dialog: {
      showOpenDialog: (options: Electron.OpenDialogOptions) => ipcRenderer.invoke('fs:dialog:show-open-dialog', options),
      showSaveDialog: (options: Electron.SaveDialogOptions) => ipcRenderer.invoke('fs:dialog:show-save-dialog', options)
    }
  },
  realdebrid: {
    setKey: (key: string) => ipcRenderer.invoke('real-debrid:set-key', key),
    getUserInfo: () => ipcRenderer.invoke('real-debrid:get-user-info'),
    unrestrictLink: (link: string) => ipcRenderer.invoke('real-debrid:unrestrict-link', link),
    addMagnet: (url: string, host: $Hosts) => ipcRenderer.invoke('real-debrid:add-magnet', { url, host }),
    getHosts: () => ipcRenderer.invoke('real-debrid:get-hosts'),
    updateKey: () => ipcRenderer.invoke('real-debrid:update-key'),
    addTorrent: (torrent: string, host: $Hosts) => ipcRenderer.invoke('real-debrid:add-torrent', { torrent, host }),
    selectTorrent: (torrents: number[]) => ipcRenderer.invoke('real-debrid:select-torrent', torrents),
    isTorrentReady: (id: string) => ipcRenderer.invoke('real-debrid:is-torrent-ready', id),
    getTorrentInfo: (id: string) => ipcRenderer.invoke('real-debrid:get-torrent-info', id)
  },
  ddl: {
    download: (downloads: { link: string, path: string }[]) => ipcRenderer.invoke('ddl:download', downloads)
  },
  torrent: {
    downloadTorrent: (torrent: string, path: string) => ipcRenderer.invoke('torrent:download-torrent', { link: torrent, path }),
    downloadMagnet: (magnet: string, path: string) => ipcRenderer.invoke('torrent:download-magnet', { link: magnet, path }),
  },
  oobe: {
    downloadTools: () => ipcRenderer.invoke('oobe:download-tools'),
  },
  app: {
    close: () => ipcRenderer.invoke('app:close'),
    minimize: () => ipcRenderer.invoke('app:minimize'),
    axios: (options: AxiosRequestConfig) => ipcRenderer.invoke('app:axios', options),
    searchFor: (query: string) => ipcRenderer.invoke('app:search-id', query),
    inputSend: (id: string, data: any) => ipcRenderer.invoke('app:screen-input', { id, data }),
    insertApp: (info: LibraryInfo) => ipcRenderer.invoke('app:insert-app', info),
    getAllApps: () => ipcRenderer.invoke('app:get-all-apps'),
  },
  getVersion: () => ipcRenderer.sendSync('get-version'),
  updateAddons: () => ipcRenderer.invoke('update-addons'),
  installAddons: (addons: string[]) => ipcRenderer.invoke('install-addons', addons),
  restartAddonServer: () => ipcRenderer.invoke('restart-addon-server'),
  cleanAddons: () => ipcRenderer.invoke('clean-addons'),
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

ipcRenderer.on('torrent:download-progress', (_, arg) => {
  document.dispatchEvent(new CustomEvent('torrent:download-progress', { detail: arg }));
});

ipcRenderer.on('torrent:download-error', (_, arg) => {
  document.dispatchEvent(new CustomEvent('torrent:download-error', { detail: arg }));
});

ipcRenderer.on('torrent:download-complete', (_, arg) => {
  document.dispatchEvent(new CustomEvent('torrent:download-complete', { detail: arg }));
});

ipcRenderer.on('input-asked', (_, arg) => {
  document.dispatchEvent(new CustomEvent('input-asked', { detail: arg }));
});