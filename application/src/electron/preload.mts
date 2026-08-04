import { randomUUID } from 'node:crypto';
import type { LibraryInfo } from '@ogi-sdk/connect';
import { AxiosRequestConfig } from 'axios';
import { contextBridge, ipcRenderer } from 'electron';
import { makeElectronRpcClient } from '@/electron/rpc/client.js';
import type { ElectronRouter } from '@/electron/rpc/router.js';
import { ELECTRON_RPC_CHANNEL } from '@/lib/electron-rpc.js';

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
const rpcSessionId = randomUUID();
const rpcClient = makeElectronRpcClient<ElectronRouter>((message) =>
  ipcRenderer.invoke(ELECTRON_RPC_CHANNEL, {
    sessionId: rpcSessionId,
    message,
  })
);
const electronRpc = rpcClient.router;

window.addEventListener('unload', () => {
  void rpcClient.close();
});

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
      return electronRpc.fs.deleteAsync(path);
    }),
    move: wrap((data: { source: string; destination: string }) => {
      console.log(
        'fs:move called with source:',
        data.source,
        'destination:',
        data.destination
      );
      return electronRpc.fs.move(data);
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
        return electronRpc.fs.unrar(data);
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
        return electronRpc.fs.unzip(data);
      }
    ),
    getFilesInDir: wrap((path: string) => {
      console.log('fs:getFilesInDir called with path:', path);
      return electronRpc.fs.getFilesInDir(path);
    }),
    stat: wrap((path: string) => {
      console.log('fs:stat called with path:', path);
      return ipcRenderer.sendSync('fs:stat', { path });
    }),
    dialog: {
      showOpenDialog: wrap((options: Electron.OpenDialogOptions) => {
        console.log('fs:dialog:showOpenDialog called with options:', options);
        return electronRpc.fs.dialog.showOpenDialog(options);
      }),
      showSaveDialog: wrap((options: Electron.SaveDialogOptions) => {
        console.log('fs:dialog:showSaveDialog called with options:', options);
        return electronRpc.fs.dialog.showSaveDialog(options);
      }),
    },
  },
  realdebrid: {
    setKey: wrap((key: string) => electronRpc.realdebrid.setKey(key)),
    getUserInfo: wrap(() => electronRpc.realdebrid.getUserInfo()),
    unrestrictLink: wrap((link: string) =>
      electronRpc.realdebrid.unrestrictLink(link)
    ),
    addMagnet: wrap((url: string, host?: string) =>
      electronRpc.realdebrid.addMagnet({ url, host })
    ),
    getHosts: wrap(() => electronRpc.realdebrid.getHosts()),
    updateKey: wrap(() => electronRpc.realdebrid.updateKey()),
    addTorrent: wrap((torrent: string, host?: string) =>
      electronRpc.realdebrid.addTorrent({ torrent, host })
    ),
    selectTorrent: wrap((torrent: string) =>
      electronRpc.realdebrid.selectTorrent(torrent)
    ),
    isTorrentReady: wrap((id: string) =>
      electronRpc.realdebrid.isTorrentReady(id)
    ),
    getTorrentInfo: wrap((id: string) =>
      electronRpc.realdebrid.getTorrentInfo(id)
    ),
  },
  alldebrid: {
    setKey: wrap((key: string) => electronRpc.alldebrid.setKey(key)),
    getUserInfo: wrap(() => electronRpc.alldebrid.getUserInfo()),
    unrestrictLink: wrap((link: string) =>
      electronRpc.alldebrid.unrestrictLink(link)
    ),
    addMagnet: wrap((url: string, host?: string) =>
      electronRpc.alldebrid.addMagnet({ url, host })
    ),
    getHosts: wrap(() => electronRpc.alldebrid.getHosts()),
    updateKey: wrap(() => electronRpc.alldebrid.updateKey()),
    addTorrent: wrap((torrent: string) =>
      electronRpc.alldebrid.addTorrent({ torrent })
    ),
    selectTorrent: wrap(() => electronRpc.alldebrid.selectTorrent()),
    isTorrentReady: wrap((id: string) =>
      electronRpc.alldebrid.isTorrentReady(id)
    ),
    getTorrentInfo: wrap((id: string) =>
      electronRpc.alldebrid.getTorrentInfo(id)
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
      ) => electronRpc.ddl.download(downloads, part)
    ),
    abortDownload: wrap((downloadID: string) =>
      electronRpc.ddl.abortDownload(downloadID)
    ),
    pauseDownload: wrap((downloadID: string) =>
      electronRpc.ddl.pauseDownload(downloadID)
    ),
    resumeDownload: wrap((downloadID: string) =>
      electronRpc.ddl.resumeDownload(downloadID)
    ),
  },
  download: {
    consumeReplayEvents: wrap((id: string) =>
      electronRpc.download.consumeReplayEvents(id)
    ),
    getHandshakeState: wrap((id: string) =>
      electronRpc.download.getHandshakeState(id)
    ),
  },
  queue: {
    cancel: wrap((downloadID: string) => electronRpc.queue.cancel(downloadID)),
  },
  torrent: {
    downloadTorrent: wrap((torrent: string, path: string) =>
      electronRpc.torrent.downloadTorrent({ link: torrent, path })
    ),
    downloadMagnet: wrap((magnet: string, path: string) =>
      electronRpc.torrent.downloadMagnet({ link: magnet, path })
    ),
    pauseDownload: wrap((downloadID: string) =>
      electronRpc.torrent.pauseDownload(downloadID)
    ),
    resumeDownload: wrap((downloadID: string) =>
      electronRpc.torrent.resumeDownload(downloadID)
    ),
  },
  oobe: {
    downloadTools: wrap(() => electronRpc.oobe.downloadTools()),
    setSteamGridDBKey: wrap((key: string) =>
      electronRpc.oobe.setSteamGridDBKey(key)
    ),
  },
  app: {
    close: wrap(() => electronRpc.app.close()),
    hideWindow: wrap(() => electronRpc.app.hideWindow()),
    showWindow: wrap(() => electronRpc.app.showWindow()),
    minimize: wrap(() => electronRpc.app.minimize()),
    quit: wrap(() => electronRpc.app.quit()),
    axios: wrap((options: AxiosRequestConfig) =>
      electronRpc.app.axios(options)
    ),
    clientReadyForEvents: wrap(() =>
      ipcRenderer.send('client-ready-for-events')
    ),
    inputSend: wrap((id: string, data: any) =>
      electronRpc.app.inputSend({ id, data })
    ),
    insertApp: wrap((info: LibraryInfo) => electronRpc.app.insertApp(info)),
    getAllApps: wrap(() => electronRpc.app.getAllApps()),
    launchGame: wrap((appid: string) => electronRpc.app.launchGame(appid)),
    removeApp: wrap((appid: number) => electronRpc.app.removeApp(appid)),
    getOS: wrap(() => electronRpc.app.getOS()),
    isSteamDeck: wrap(() => electronRpc.app.isSteamDeck()),
    isOnline: wrap(() => electronRpc.app.isOnline()),
    getAddonPath: wrap((addonID: string) =>
      electronRpc.app.getAddonPath(addonID)
    ),
    getAddonIcon: wrap((addonID: string) =>
      electronRpc.app.getAddonIcon(addonID)
    ),
    getLocalImage: wrap((path: string) => electronRpc.app.getLocalImage(path)),
    grantRootPassword: wrap((password: string) =>
      electronRpc.app.grantRootPassword(password)
    ),
    openSteamKeyboard: wrap(
      (options: { x: number; y: number; width: number; height: number }) =>
        electronRpc.app.openSteamKeyboard(options)
    ),
    updateAppVersion: wrap(
      (
        appID: number,
        version: string,
        cwd: string,
        launchExecutable: string,
        launchArguments?: string,
        addonSource?: string,
        umu?: LibraryInfo['umu'],
        launchEnv?: LibraryInfo['launchEnv']
      ) =>
        electronRpc.app.updateAppVersion({
          appID,
          version,
          cwd,
          launchExecutable,
          launchArguments,
          addonSource,
          umu,
          launchEnv,
        })
    ),
    addToSteam: wrap((appID: number, oldSteamAppId?: number) =>
      electronRpc.app.addToSteam(appID, oldSteamAppId)
    ),
    removeFromSteam: wrap((appID: number) =>
      electronRpc.app.removeFromSteam(appID)
    ),
    launchSteamApp: wrap((appID: number) =>
      electronRpc.app.launchSteamApp(appID)
    ),
    checkPrefixExists: wrap((appID: number) =>
      electronRpc.app.checkPrefixExists(appID)
    ),
    installRedistributables: wrap((appID: number, downloadId?: string) =>
      electronRpc.app.installRedistributables(appID, downloadId)
    ),
    getSteamAppId: wrap((appID: number) =>
      electronRpc.app.getSteamAppId(appID)
    ),
    addToDesktop: wrap(() => electronRpc.app.addToDesktop()),
    getLibraryInfo: wrap((appID: number) =>
      electronRpc.app.getLibraryInfo(appID)
    ),
    executeWrapperCommand: wrap((appID: number, wrapperCommand: string) =>
      electronRpc.app.executeWrapperCommand(appID, wrapperCommand)
    ),
    checkUmuInstalled: wrap(() => electronRpc.app.checkUmuInstalled()),
    installUmu: wrap(() => electronRpc.app.installUmu()),
    launchWithUmu: wrap((appID: number) =>
      electronRpc.app.launchWithUmu(appID)
    ),
    installRedistributablesUmu: wrap((appID: number) =>
      electronRpc.app.installRedistributablesUmu(appID)
    ),
    migrateToUmu: wrap((appID: number, oldSteamAppId?: number) =>
      electronRpc.app.migrateToUmu(appID, oldSteamAppId)
    ),
  },
  getVersion: wrap(() => ipcRenderer.sendSync('get-version')),
  getTheme: wrap(() => ipcRenderer.sendSync('get-initial-theme')),
  updateAddons: wrap(() => electronRpc.updateAddons()),
  installAddons: wrap((addons: string[]) => electronRpc.installAddons(addons)),
  isDev: wrap(() => ipcRenderer.sendSync('is-dev')),
  restartAddonServer: wrap(() => electronRpc.restartAddonServer()),
  deleteInstalledAddon: wrap((addonID: string) =>
    electronRpc.deleteInstalledAddon(addonID)
  ),
  cleanAddons: wrap((marketplaceUrls: string[]) =>
    electronRpc.cleanAddons(marketplaceUrls)
  ),
  downloadTorrentInto: wrap((link: string) =>
    electronRpc.downloadTorrentInto(link)
  ),
  getTorrentHash: wrap((torrent: string | Buffer | Uint8Array) =>
    electronRpc.getTorrentHash(torrent)
  ),
  powerSave: {
    setActive: wrap((active: boolean) =>
      electronRpc.powerSave.setActive(active)
    ),
  },
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
  'app:redistributable-progress',
  wrap((_, arg) => {
    document.dispatchEvent(
      new CustomEvent('app:redistributable-progress', { detail: arg })
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
  'game:launch-requested',
  wrap((_, arg) => {
    document.dispatchEvent(
      new CustomEvent('game:launch-requested', { detail: arg })
    );
  })
);

ipcRenderer.on(
  'game:launch',
  wrap((_, arg) => {
    document.dispatchEvent(new CustomEvent('game:launch', { detail: arg }));
  })
);

ipcRenderer.on(
  'game:launch-error',
  wrap((_, arg) => {
    document.dispatchEvent(
      new CustomEvent('game:launch-error', { detail: arg })
    );
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
  'all-addons-started',
  wrap(() => {
    console.log('ALL ADDONS STARTED');
    document.dispatchEvent(new CustomEvent('all-addons-started'));
  })
);

ipcRenderer.on(
  'addon-runtime-ready',
  wrap(() => {
    console.log('ADDON RUNTIME READY');
    document.dispatchEvent(new CustomEvent('addon-runtime-ready'));
  })
);

ipcRenderer.on(
  'app:show-changelog',
  wrap((_, arg) => {
    document.dispatchEvent(
      new CustomEvent('app:show-changelog', { detail: { version: arg } })
    );
  })
);

// Single-window / Steam Deck: main window shows splash.html first; forward splash IPC so it can update
ipcRenderer.on(
  'splash-status',
  wrap((_, text: string, subtext?: string) => {
    document.dispatchEvent(
      new CustomEvent('splash-status', { detail: { text, subtext } })
    );
  })
);
ipcRenderer.on(
  'splash-progress',
  wrap((_, current: number, total: number, speed?: string) => {
    document.dispatchEvent(
      new CustomEvent('splash-progress', {
        detail: { current, total, speed },
      })
    );
  })
);
