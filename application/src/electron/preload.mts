import { AxiosRequestConfig } from 'axios';
import { contextBridge, ipcRenderer } from 'electron';
import { LibraryInfo } from 'ogi-addon';
import type { $Hosts } from 'real-debrid-js';

contextBridge.exposeInMainWorld('electronAPI', {
  fs: {
    read: (path: string) => {
      console.log('fs:read called with path:', path);
      return ipcRenderer.sendSync('fs:read', path);
    },
    write: (path: string, data: string) => {
      console.log(
        'fs:write called with path:',
        path,
        'data length:',
        data.length
      );
      return ipcRenderer.sendSync('fs:write', { path, data });
    },
    mkdir: (path: string) => {
      console.log('fs:mkdir called with path:', path);
      return ipcRenderer.sendSync('fs:mkdir', path);
    },
    exists: (path: string) => {
      console.log('fs:exists called with path:', path);
      return ipcRenderer.sendSync('fs:exists', path);
    },
    delete: (path: string) => {
      console.log('fs:delete called with path:', path);
      return ipcRenderer.sendSync('fs:delete:sync', path);
    },
    deleteAsync: (path: string) => {
      console.log('fs:delete called with path:', path);
      return ipcRenderer.invoke('fs:delete', path);
    },
    showFileLoc: (path: string) => {
      console.log('fs:showFileLoc called with path:', path);
      return ipcRenderer.sendSync('fs:show-file-loc', path);
    },
    unrar: (data: {
      outputDir: string;
      rarFilePath: string;
      downloadId?: string;
    }) => {
      console.log(
        'fs:unrar called with outputDir:',
        data.outputDir,
        'rarFilePath:',
        data.rarFilePath,
        'downloadId:',
        data.downloadId
      );
      return ipcRenderer.invoke('fs:extract-rar', data);
    },
    unzip: (data: {
      zipFilePath: string;
      outputDir: string;
      downloadId?: string;
    }) => {
      console.log(
        'fs:unzip called with zipFilePath:',
        data.zipFilePath,
        'outputDir:',
        data.outputDir,
        'downloadId:',
        data.downloadId
      );
      return ipcRenderer.invoke('fs:extract-zip', data);
    },
    getFilesInDir: (path: string) => {
      console.log('fs:getFilesInDir called with path:', path);
      return ipcRenderer.invoke('fs:get-files-in-dir', path);
    },
    stat: (path: string) => {
      console.log('fs:stat called with path:', path);
      return ipcRenderer.sendSync('fs:stat', { path });
    },
    dialog: {
      showOpenDialog: (options: Electron.OpenDialogOptions) => {
        console.log('fs:dialog:showOpenDialog called with options:', options);
        return ipcRenderer.invoke('fs:dialog:show-open-dialog', options);
      },
      showSaveDialog: (options: Electron.SaveDialogOptions) => {
        console.log('fs:dialog:showSaveDialog called with options:', options);
        return ipcRenderer.invoke('fs:dialog:show-save-dialog', options);
      },
    },
  },
  realdebrid: {
    setKey: (key: string) => ipcRenderer.invoke('real-debrid:set-key', key),
    getUserInfo: () => ipcRenderer.invoke('real-debrid:get-user-info'),
    unrestrictLink: (link: string) =>
      ipcRenderer.invoke('real-debrid:unrestrict-link', link),
    addMagnet: (url: string, host: $Hosts) =>
      ipcRenderer.invoke('real-debrid:add-magnet', { url, host }),
    getHosts: () => ipcRenderer.invoke('real-debrid:get-hosts'),
    updateKey: () => ipcRenderer.invoke('real-debrid:update-key'),
    addTorrent: (torrent: string, host: $Hosts) =>
      ipcRenderer.invoke('real-debrid:add-torrent', { torrent, host }),
    selectTorrent: (torrents: number[]) =>
      ipcRenderer.invoke('real-debrid:select-torrent', torrents),
    isTorrentReady: (id: string) =>
      ipcRenderer.invoke('real-debrid:is-torrent-ready', id),
    getTorrentInfo: (id: string) =>
      ipcRenderer.invoke('real-debrid:get-torrent-info', id),
  },
  ddl: {
    download: (
      downloads: {
        link: string;
        path: string;
        headers?: Record<string, string>;
      }[],
      part?: number
    ) => ipcRenderer.invoke('ddl:download', downloads, part),
    abortDownload: (downloadID: string) =>
      ipcRenderer.invoke('ddl:abort', downloadID),
    pauseDownload: (downloadID: string) =>
      ipcRenderer.invoke('ddl:pause', downloadID),
    resumeDownload: (downloadID: string) =>
      ipcRenderer.invoke('ddl:resume', downloadID),
  },
  queue: {
    cancel: (downloadID: string) =>
      ipcRenderer.invoke(`queue:${downloadID}:cancel`),
  },
  torrent: {
    downloadTorrent: (torrent: string, path: string) =>
      ipcRenderer.invoke('torrent:download-torrent', { link: torrent, path }),
    downloadMagnet: (magnet: string, path: string) =>
      ipcRenderer.invoke('torrent:download-magnet', { link: magnet, path }),
    pauseDownload: (downloadID: string) =>
      ipcRenderer.invoke(`torrent:${downloadID}:pause`),
    resumeDownload: (downloadID: string) =>
      ipcRenderer.invoke(`torrent:${downloadID}:resume`),
  },
  oobe: {
    downloadTools: () => ipcRenderer.invoke('oobe:download-tools'),
    setSteamGridDBKey: (key: string) =>
      ipcRenderer.invoke('oobe:set-steamgriddb-key', key),
  },
  app: {
    close: () => ipcRenderer.invoke('app:close'),
    minimize: () => ipcRenderer.invoke('app:minimize'),
    axios: (options: AxiosRequestConfig) =>
      ipcRenderer.invoke('app:axios', options),
    inputSend: (id: string, data: any) =>
      ipcRenderer.invoke('app:screen-input', { id, data }),
    insertApp: (info: LibraryInfo) =>
      ipcRenderer.invoke('app:insert-app', info),
    getAllApps: () => ipcRenderer.invoke('app:get-all-apps'),
    launchGame: (appid: string) => ipcRenderer.invoke('app:launch-game', appid),
    removeApp: (appid: number) => ipcRenderer.invoke('app:remove-app', appid),
    getOS: () => ipcRenderer.invoke('app:get-os'),
    isOnline: () => ipcRenderer.invoke('app:is-online'),
    request: (
      method: string,
      params: any
    ): Promise<{
      taskID?: string;
      data?: any;
      error?: string;
      status?: number;
    }> => ipcRenderer.invoke('addon:request', { method, params }),
    getAddonPath: (addonID: string) =>
      ipcRenderer.invoke('app:get-addon-path', addonID),
    getAddonIcon: (addonID: string) =>
      ipcRenderer.invoke('app:get-addon-icon', addonID),
    getLocalImage: (path: string) =>
      ipcRenderer.invoke('app:get-local-image', path),
    grantRootPassword: (password: string) =>
      ipcRenderer.invoke('app:root-password-granted', password),
  },
  getVersion: () => ipcRenderer.sendSync('get-version'),
  updateAddons: () => ipcRenderer.invoke('update-addons'),
  installAddons: (addons: string[]) =>
    ipcRenderer.invoke('install-addons', addons),
  restartAddonServer: () => ipcRenderer.invoke('restart-addon-server'),
  cleanAddons: () => ipcRenderer.invoke('clean-addons'),
  downloadTorrentInto: (link: string) =>
    ipcRenderer.invoke('download-torrent-into', link),
  getTorrentHash: (torrent: string | Buffer | Uint8Array) =>
    ipcRenderer.invoke('torrent:get-hash', torrent),
});

// === Debug: Events Processed/sec Counter ===
let dbg_eventsProcessed = 0;
let dbg_lastReportTime = Date.now();

function dbg_countEvent() {
  dbg_eventsProcessed++;
}

setInterval(() => {
  const now = Date.now();
  const elapsed = (now - dbg_lastReportTime) / 1000;
  const eventsPerSec = dbg_eventsProcessed / elapsed;
  document.dispatchEvent(
    new CustomEvent('dbg:events-proc', { detail: { eventsPerSec } })
  );
  dbg_eventsProcessed = 0;
  dbg_lastReportTime = now;
}, 3000);

ipcRenderer.on('ddl:download-progress', (_, arg) => {
  dbg_countEvent();
  document.dispatchEvent(
    new CustomEvent('ddl:download-progress', { detail: arg })
  );
});

ipcRenderer.on('ddl:download-error', (_, arg) => {
  dbg_countEvent();
  document.dispatchEvent(
    new CustomEvent('ddl:download-error', { detail: arg })
  );
});
ipcRenderer.on('ddl:download-complete', (_, arg) => {
  dbg_countEvent();
  document.dispatchEvent(
    new CustomEvent('ddl:download-complete', { detail: arg })
  );
});

ipcRenderer.on('ddl:download-cancelled', (_, arg) => {
  dbg_countEvent();
  document.dispatchEvent(
    new CustomEvent('ddl:download-cancelled', { detail: arg })
  );
});

ipcRenderer.on('ddl:download-paused', (_, arg) => {
  dbg_countEvent();
  document.dispatchEvent(
    new CustomEvent('ddl:download-paused', { detail: arg })
  );
});

ipcRenderer.on('ddl:download-resumed', (_, arg) => {
  dbg_countEvent();
  document.dispatchEvent(
    new CustomEvent('ddl:download-resumed', { detail: arg })
  );
});

ipcRenderer.on('notification', (_, arg) => {
  dbg_countEvent();
  document.dispatchEvent(new CustomEvent('new-notification', { detail: arg }));
});

ipcRenderer.on('oobe:log', (_, arg) => {
  dbg_countEvent();
  document.dispatchEvent(new CustomEvent('oobe:log', { detail: arg }));
});

ipcRenderer.on('torrent:download-progress', (_, arg) => {
  dbg_countEvent();
  document.dispatchEvent(
    new CustomEvent('torrent:download-progress', { detail: arg })
  );
});

ipcRenderer.on('torrent:download-error', (_, arg) => {
  dbg_countEvent();
  document.dispatchEvent(
    new CustomEvent('torrent:download-error', { detail: arg })
  );
});

ipcRenderer.on('torrent:download-complete', (_, arg) => {
  dbg_countEvent();
  document.dispatchEvent(
    new CustomEvent('torrent:download-complete', { detail: arg })
  );
});

ipcRenderer.on('torrent:download-cancelled', (_, arg) => {
  dbg_countEvent();
  document.dispatchEvent(
    new CustomEvent('torrent:download-cancelled', { detail: arg })
  );
});

ipcRenderer.on('torrent:download-paused', (_, arg) => {
  dbg_countEvent();
  document.dispatchEvent(
    new CustomEvent('torrent:download-paused', { detail: arg })
  );
});

ipcRenderer.on('torrent:download-resumed', (_, arg) => {
  dbg_countEvent();
  document.dispatchEvent(
    new CustomEvent('torrent:download-resumed', { detail: arg })
  );
});

ipcRenderer.on('input-asked', (_, arg) => {
  dbg_countEvent();
  document.dispatchEvent(new CustomEvent('input-asked', { detail: arg }));
});

ipcRenderer.on('game:launch-error', (_, arg) => {
  dbg_countEvent();
  document.dispatchEvent(new CustomEvent('game:launched', { detail: arg }));
});
ipcRenderer.on('game:exit', (_, arg) => {
  dbg_countEvent();
  document.dispatchEvent(new CustomEvent('game:exit', { detail: arg }));
});
ipcRenderer.on('addon:update-available', (_, arg) => {
  dbg_countEvent();
  document.dispatchEvent(
    new CustomEvent('addon:update-available', { detail: arg })
  );
});
ipcRenderer.on('addon:updated', (_, arg) => {
  dbg_countEvent();
  document.dispatchEvent(new CustomEvent('addon:updated', { detail: arg }));
});

ipcRenderer.on('addon-connected', (_, arg) => {
  dbg_countEvent();
  document.dispatchEvent(new CustomEvent('addon-connected', { detail: arg }));
});

ipcRenderer.on('migration:event', (_, arg) => {
  dbg_countEvent();
  document.dispatchEvent(
    new CustomEvent(`migration:event:${arg}`, { detail: arg })
  );
});

ipcRenderer.on('app:open-steam-compatdata', (_, arg) => {
  dbg_countEvent();
  document.dispatchEvent(
    new CustomEvent('app:open-steam-compatdata', { detail: arg })
  );
});

ipcRenderer.on('app:ask-root-password', (_, arg) => {
  dbg_countEvent();
  document.dispatchEvent(
    new CustomEvent('app:ask-root-password', { detail: arg })
  );
});

ipcRenderer.send('client-ready-for-events');
