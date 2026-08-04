import type { BrowserWindow } from 'electron';
import AddonManagerHandler from '@/electron/handlers/handler.addon.js';
import AllDebridHandler from '@/electron/handlers/handler.alldebrid.js';
import AppEventHandler from '@/electron/handlers/handler.app.js';
import DirectDownloadHandler from '@/electron/handlers/handler.ddl.js';
import FSEventHandler from '@/electron/handlers/handler.fs.js';
import OOBEHandler from '@/electron/handlers/handler.oobe.js';
import { registerPowerSaveHandlers } from '@/electron/handlers/handler.power-save.js';
import RealdDebridHandler from '@/electron/handlers/handler.realdebrid.js';
import TorrentHandler from '@/electron/handlers/handler.torrent.js';
import { registerUmuHandlers } from '@/electron/handlers/handler.umu.js';
import { cancelQueuedDownload } from '@/electron/rpc/queue-cancel.js';
import { mergeRouters, procedure, router } from '@/electron/rpc/router-core.js';
import { registerDownloadHandshakeHandlers } from '@/lib/download-handshake.js';
import { ElectronRpc } from '@/lib/electron-rpc.js';

export function createElectronRouter(mainWindow: BrowserWindow) {
  return mergeRouters(
    AppEventHandler(mainWindow),
    FSEventHandler(),
    RealdDebridHandler(mainWindow),
    AllDebridHandler(mainWindow),
    TorrentHandler(mainWindow),
    DirectDownloadHandler(mainWindow),
    AddonManagerHandler(mainWindow),
    OOBEHandler(),
    registerUmuHandlers(),
    registerPowerSaveHandlers(),
    registerDownloadHandshakeHandlers(),
    router(
      procedure(ElectronRpc.queue.cancel, (downloadID: string) =>
        cancelQueuedDownload(downloadID)
      )
    )
  );
}
