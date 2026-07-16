import { ipcMain } from 'electron';
import { Effect } from 'effect';
import { setPowerSaveBlockActive } from '@/electron/lib/power-save.js';

export function registerPowerSaveHandlers(): void {
  ipcMain.handle('power-save:set-active', (_, active: boolean) =>
    Effect.runPromise(
      Effect.sync(() => setPowerSaveBlockActive(active)).pipe(
        Effect.catchAll(() => Effect.void)
      )
    )
  );
}
