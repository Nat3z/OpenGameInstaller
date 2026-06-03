import { ipcMain } from 'electron';
import { setPowerSaveBlockActive } from '@/electron/lib/power-save.js';

export function registerPowerSaveHandlers() {
  ipcMain.handle('power-save:set-active', (_, active: boolean) => {
    setPowerSaveBlockActive(active);
  });
}
