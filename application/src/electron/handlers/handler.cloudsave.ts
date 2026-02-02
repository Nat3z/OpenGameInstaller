/**
 * IPC handlers for cloud save: get/set config, sync down/up, last sync, status.
 */
import { ipcMain } from 'electron';
import {
  getCloudSaveConfig,
  setCloudSaveConfig,
  getLastSyncTime,
  getPathsForApp,
  isCloudSaveEnabledForApp,
  type CloudSaveConfig,
} from '../manager/manager.cloudsave.js';
import { uploadSave, downloadSave } from '../lib/cloudsave-sync.js';

export type CloudSaveStatusPayload =
  | { appID: number; status: 'syncing-down'; progress?: number }
  | { appID: number; status: 'syncing-up'; progress?: number }
  | { appID: number; status: 'down-complete' }
  | { appID: number; status: 'up-complete' }
  | { appID: number; status: 'error'; message: string };

export function registerCloudSaveHandlers(mainWindow: Electron.BrowserWindow): void {
  ipcMain.handle('cloudsave:get-config', async () => {
    return getCloudSaveConfig();
  });

  ipcMain.handle('cloudsave:set-config', async (_, config: CloudSaveConfig) => {
    setCloudSaveConfig(config);
    return;
  });

  ipcMain.handle('cloudsave:get-last-sync', async (_, appID: number) => {
    return getLastSyncTime(appID);
  });

  ipcMain.handle('cloudsave:sync-down', async (_, appID: number) => {
    if (!mainWindow?.webContents) return { success: false, error: 'No window' };
    const send = (payload: CloudSaveStatusPayload) => {
      mainWindow.webContents.send('cloudsave:status', payload);
    };
    send({ appID, status: 'syncing-down' });
    try {
      const paths = getPathsForApp(appID);
      if (paths.length === 0) {
        send({ appID, status: 'error', message: 'No paths configured' });
        return { success: false, error: 'No paths configured' };
      }
      await downloadSave(appID, paths, (progress) =>
        send({ appID, status: 'syncing-down', progress })
      );
      send({ appID, status: 'down-complete' });
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      send({ appID, status: 'error', message });
      return { success: false, error: message };
    }
  });

  ipcMain.handle('cloudsave:sync-up', async (_, appID: number) => {
    if (!mainWindow?.webContents) return { success: false, error: 'No window' };
    const send = (payload: CloudSaveStatusPayload) => {
      mainWindow.webContents.send('cloudsave:status', payload);
    };
    send({ appID, status: 'syncing-up' });
    try {
      const paths = getPathsForApp(appID);
      if (paths.length === 0) {
        send({ appID, status: 'error', message: 'No paths configured' });
        return { success: false, error: 'No paths configured' };
      }
      await uploadSave(appID, paths, (progress) =>
        send({ appID, status: 'syncing-up', progress })
      );
      send({ appID, status: 'up-complete' });
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      send({ appID, status: 'error', message });
      return { success: false, error: message };
    }
  });

  ipcMain.handle('cloudsave:is-enabled-for-app', async (_, appID: number) => {
    return isCloudSaveEnabledForApp(appID);
  });
}

/**
 * Run cloud save upload in background after game exit. Does not block.
 */
export function runCloudSaveUploadAfterExit(
  appID: number,
  mainWindow: Electron.BrowserWindow | null
): void {
  if (!isCloudSaveEnabledForApp(appID)) return;
  const send = (payload: CloudSaveStatusPayload) => {
    mainWindow?.webContents?.send('cloudsave:status', payload);
  };
  (async () => {
    send({ appID, status: 'syncing-up' });
    try {
      const paths = getPathsForApp(appID);
      if (paths.length === 0) {
        send({ appID, status: 'error', message: 'No paths configured' });
        return;
      }
      await uploadSave(appID, paths, (progress) =>
        send({ appID, status: 'syncing-up', progress })
      );
      send({ appID, status: 'up-complete' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      send({ appID, status: 'error', message });
    }
  })();
}
