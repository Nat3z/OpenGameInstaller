import { AxiosRequestConfig } from 'axios';
import { contextBridge, ipcRenderer } from 'electron';
import { LibraryInfo } from 'ogi-addon';
import type { $Hosts } from 'real-debrid-js';

// === Debug: Events Processed/sec Counter ===
let dbg_eventsProcessed = 0;
let dbg_lastReportTime = Date.now();

function dbg_countEvent() {
  dbg_eventsProcessed++;
}

const wrap = (fn: (...args: any[]) => any) => {
  return (...args: any[]) => {
    dbg_countEvent();
    try {
      return fn(...args);
    } catch (e) {
      document.dispatchEvent(new CustomEvent('dbg:error', { detail: e }));
      return undefined;
    }
  };
};
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

contextBridge.exposeInMainWorld('electronAPI', {
  fs: {
    read: wrap((path: string) => {
      console.log('fs:read called with path:', path);
      return ipcRenderer.sendSync('fs:read', path);
    }),
    write: wrap((path: string, data: string) => {
      console.log(
        'fs:write called with path:',
        path,
        'data length:',
        data.length
      );
      return ipcRenderer.sendSync('fs:write', { path, data });
    }),
    mkdir: wrap((path: string) => {
      console.log('fs:mkdir called with path:', path);
      return ipcRenderer.sendSync('fs:mkdir', path);
    }),
    exists: wrap((path: string) => {
      console.log('fs:exists called with path:', path);
      return ipcRenderer.sendSync('fs:exists', path);
    }),
    delete: wrap((path: string) => {
      console.log('fs:delete called with path:', path);
      return ipcRenderer.sendSync('fs:delete:sync', path);
    }),
    deleteAsync: wrap((path: string) => {
      console.log('fs:delete called with path:', path);
      return ipcRenderer.invoke('fs:delete', path);
    }),
    showFileLoc: wrap((path: string) => {
      console.log('fs:showFileLoc called with path:', path);
      return ipcRenderer.sendSync('fs:show-file-loc', path);
    }),
    unrar: wrap(
      (data: {
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
      }
    ),
    unzip: wrap(
      (data: {
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
      }
    ),
    getFilesInDir: wrap((path: string) => {
      console.log('fs:getFilesInDir called with path:', path);
      return ipcRenderer.invoke('fs:get-files-in-dir', path);
    }),
    stat: wrap((path: string) => {
      console.log('fs:stat called with path:', path);
      return ipcRenderer.sendSync('fs:stat', { path });
    }),
    dialog: {
      showOpenDialog: wrap((options: Electron.OpenDialogOptions) => {
        console.log('fs:dialog:showOpenDialog called with options:', options);
        return ipcRenderer.invoke('fs:dialog:show-open-dialog', options);
      }),
      showSaveDialog: wrap((options: Electron.SaveDialogOptions) => {
        console.log('fs:dialog:showSaveDialog called with options:', options);
        return ipcRenderer.invoke('fs:dialog:show-save-dialog', options);
      }),
    },
  },
  realdebrid: {
    setKey: wrap((key: string) =>
      ipcRenderer.invoke('real-debrid:set-key', key)
    ),
    getUserInfo: wrap(() => ipcRenderer.invoke('real-debrid:get-user-info')),
    unrestrictLink: wrap((link: string) =>
      ipcRenderer.invoke('real-debrid:unrestrict-link', link)
    ),
    addMagnet: wrap((url: string, host: $Hosts) =>
      ipcRenderer.invoke('real-debrid:add-magnet', { url, host })
    ),
    getHosts: wrap(() => ipcRenderer.invoke('real-debrid:get-hosts')),
    updateKey: wrap(() => ipcRenderer.invoke('real-debrid:update-key')),
    addTorrent: wrap((torrent: string, host: $Hosts) =>
      ipcRenderer.invoke('real-debrid:add-torrent', { torrent, host })
    ),
    selectTorrent: wrap((torrents: number[]) =>
      ipcRenderer.invoke('real-debrid:select-torrent', torrents)
    ),
    isTorrentReady: wrap((id: string) =>
      ipcRenderer.invoke('real-debrid:is-torrent-ready', id)
    ),
    getTorrentInfo: wrap((id: string) =>
      ipcRenderer.invoke('real-debrid:get-torrent-info', id)
    ),
  },
  ddl: {
    download: wrap(
      (
        downloads: {
          link: string;
          path: string;
          headers?: Record<string, string>;
        }[],
        part?: number
      ) => ipcRenderer.invoke('ddl:download', downloads, part)
    ),
    abortDownload: wrap((downloadID: string) =>
      ipcRenderer.invoke('ddl:abort', downloadID)
    ),
    pauseDownload: wrap((downloadID: string) =>
      ipcRenderer.invoke('ddl:pause', downloadID)
    ),
    resumeDownload: wrap((downloadID: string) =>
      ipcRenderer.invoke('ddl:resume', downloadID)
    ),
  },
  queue: {
    cancel: wrap((downloadID: string) =>
      ipcRenderer.invoke(`queue:${downloadID}:cancel`)
    ),
  },
  torrent: {
    downloadTorrent: wrap((torrent: string, path: string) =>
      ipcRenderer.invoke('torrent:download-torrent', { link: torrent, path })
    ),
    downloadMagnet: wrap((magnet: string, path: string) =>
      ipcRenderer.invoke('torrent:download-magnet', { link: magnet, path })
    ),
    pauseDownload: wrap((downloadID: string) =>
      ipcRenderer.invoke(`torrent:pause`, downloadID)
    ),
    resumeDownload: wrap((downloadID: string) =>
      ipcRenderer.invoke(`torrent:resume`, downloadID)
    ),
  },
  oobe: {
    downloadTools: wrap(() => ipcRenderer.invoke('oobe:download-tools')),
    setSteamGridDBKey: wrap((key: string) =>
      ipcRenderer.invoke('oobe:set-steamgriddb-key', key)
    ),
  },
  app: {
    close: wrap(() => ipcRenderer.invoke('app:close')),
    minimize: wrap(() => ipcRenderer.invoke('app:minimize')),
    axios: wrap((options: AxiosRequestConfig) =>
      ipcRenderer.invoke('app:axios', options)
    ),
    inputSend: wrap((id: string, data: any) =>
      ipcRenderer.invoke('app:screen-input', { id, data })
    ),
    insertApp: wrap((info: LibraryInfo) =>
      ipcRenderer.invoke('app:insert-app', info)
    ),
    getAllApps: wrap(() => ipcRenderer.invoke('app:get-all-apps')),
    launchGame: wrap((appid: string) =>
      ipcRenderer.invoke('app:launch-game', appid)
    ),
    removeApp: wrap((appid: number) =>
      ipcRenderer.invoke('app:remove-app', appid)
    ),
    getOS: wrap(() => ipcRenderer.invoke('app:get-os')),
    isOnline: wrap(() => ipcRenderer.invoke('app:is-online')),
    request: wrap(
      (
        method: string,
        params: any
      ): Promise<{
        taskID?: string;
        data?: any;
        error?: string;
        status?: number;
      }> => ipcRenderer.invoke('addon:request', { method, params })
    ),
    getAddonPath: wrap((addonID: string) =>
      ipcRenderer.invoke('app:get-addon-path', addonID)
    ),
    getAddonIcon: wrap((addonID: string) =>
      ipcRenderer.invoke('app:get-addon-icon', addonID)
    ),
    getLocalImage: wrap((path: string) =>
      ipcRenderer.invoke('app:get-local-image', path)
    ),
    grantRootPassword: wrap((password: string) =>
      ipcRenderer.invoke('app:root-password-granted', password)
    ),
    openSteamKeyboard: wrap(
      (options: { previousText: string; title: string; maxChars: number }) =>
        ipcRenderer.invoke('app:open-steam-keyboard', options)
    ),
    updateAppVersion: wrap(
      (
        appID: number,
        version: string,
        cwd: string,
        launchExecutable: string,
        launchArguments?: string
      ) =>
        ipcRenderer.invoke('app:update-app-version', {
          appID,
          version,
          cwd,
          launchExecutable,
          launchArguments,
        })
    ),
  },
  getVersion: wrap(() => ipcRenderer.sendSync('get-version')),
  updateAddons: wrap(() => ipcRenderer.invoke('update-addons')),
  installAddons: wrap((addons: string[]) =>
    ipcRenderer.invoke('install-addons', addons)
  ),
  restartAddonServer: wrap(() => ipcRenderer.invoke('restart-addon-server')),
  cleanAddons: wrap(() => ipcRenderer.invoke('clean-addons')),
  downloadTorrentInto: wrap((link: string) =>
    ipcRenderer.invoke('download-torrent-into', link)
  ),
  getTorrentHash: wrap((torrent: string | Buffer | Uint8Array) =>
    ipcRenderer.invoke('torrent:get-hash', torrent)
  ),
});

ipcRenderer.on(
  'ddl:download-progress',
  wrap((_, arg) => {
    document.dispatchEvent(
      new CustomEvent('ddl:download-progress', { detail: arg })
    );
  })
);

ipcRenderer.on(
  'ddl:download-error',
  wrap((_, arg) => {
    document.dispatchEvent(
      new CustomEvent('ddl:download-error', { detail: arg })
    );
  })
);
ipcRenderer.on(
  'ddl:download-complete',
  wrap((_, arg) => {
    document.dispatchEvent(
      new CustomEvent('ddl:download-complete', { detail: arg })
    );
  })
);

ipcRenderer.on(
  'ddl:download-cancelled',
  wrap((_, arg) => {
    document.dispatchEvent(
      new CustomEvent('ddl:download-cancelled', { detail: arg })
    );
  })
);

ipcRenderer.on(
  'ddl:download-paused',
  wrap((_, arg) => {
    document.dispatchEvent(
      new CustomEvent('ddl:download-paused', { detail: arg })
    );
  })
);

ipcRenderer.on(
  'ddl:download-resumed',
  wrap((_, arg) => {
    document.dispatchEvent(
      new CustomEvent('ddl:download-resumed', { detail: arg })
    );
  })
);

ipcRenderer.on(
  'notification',
  wrap((_, arg) => {
    document.dispatchEvent(
      new CustomEvent('new-notification', { detail: arg })
    );
  })
);

ipcRenderer.on(
  'oobe:log',
  wrap((_, arg) => {
    document.dispatchEvent(new CustomEvent('oobe:log', { detail: arg }));
  })
);

ipcRenderer.on(
  'torrent:download-progress',
  wrap((_, arg) => {
    document.dispatchEvent(
      new CustomEvent('torrent:download-progress', { detail: arg })
    );
  })
);

ipcRenderer.on(
  'torrent:download-error',
  wrap((_, arg) => {
    document.dispatchEvent(
      new CustomEvent('torrent:download-error', { detail: arg })
    );
  })
);

ipcRenderer.on(
  'torrent:download-complete',
  wrap((_, arg) => {
    document.dispatchEvent(
      new CustomEvent('torrent:download-complete', { detail: arg })
    );
  })
);

ipcRenderer.on(
  'torrent:download-cancelled',
  wrap((_, arg) => {
    document.dispatchEvent(
      new CustomEvent('torrent:download-cancelled', { detail: arg })
    );
  })
);

ipcRenderer.on(
  'torrent:download-paused',
  wrap((_, arg) => {
    document.dispatchEvent(
      new CustomEvent('torrent:download-paused', { detail: arg })
    );
  })
);

ipcRenderer.on(
  'torrent:download-resumed',
  wrap((_, arg) => {
    document.dispatchEvent(
      new CustomEvent('torrent:download-resumed', { detail: arg })
    );
  })
);

ipcRenderer.on(
  'input-asked',
  wrap((_, arg) => {
    document.dispatchEvent(new CustomEvent('input-asked', { detail: arg }));
  })
);

ipcRenderer.on(
  'game:launch-error',
  wrap((_, arg) => {
    document.dispatchEvent(new CustomEvent('game:launched', { detail: arg }));
  })
);
ipcRenderer.on(
  'game:exit',
  wrap((_, arg) => {
    document.dispatchEvent(new CustomEvent('game:exit', { detail: arg }));
  })
);
ipcRenderer.on(
  'addon:update-available',
  wrap((_, arg) => {
    document.dispatchEvent(
      new CustomEvent('addon:update-available', { detail: arg })
    );
  })
);
ipcRenderer.on(
  'addon:updated',
  wrap((_, arg) => {
    document.dispatchEvent(new CustomEvent('addon:updated', { detail: arg }));
  })
);

ipcRenderer.on(
  'addon-connected',
  wrap((_, arg) => {
    document.dispatchEvent(new CustomEvent('addon-connected', { detail: arg }));
  })
);

ipcRenderer.on(
  'migration:event',
  wrap((_, arg) => {
    document.dispatchEvent(
      new CustomEvent(`migration:event:${arg}`, { detail: arg })
    );
  })
);

ipcRenderer.on(
  'app:open-steam-compatdata',
  wrap((_, arg) => {
    document.dispatchEvent(
      new CustomEvent('app:open-steam-compatdata', { detail: arg })
    );
  })
);

ipcRenderer.on(
  'app:ask-root-password',
  wrap((_, arg) => {
    document.dispatchEvent(
      new CustomEvent('app:ask-root-password', { detail: arg })
    );
  })
);

ipcRenderer.on(
  'addon-connected',
  wrap((_, arg) => {
    document.dispatchEvent(new CustomEvent('addon-connected', { detail: arg }));
  })
);

ipcRenderer.on(
  'all-addons-started',
  wrap(() => {
    console.log('ALL ADDONS STARTED');
    document.dispatchEvent(new CustomEvent('all-addons-started'));
  })
);

wrap(() => ipcRenderer.send('client-ready-for-events'))();
