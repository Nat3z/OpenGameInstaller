import { Effect } from 'effect';
import { ipcMain } from 'electron';
import { setPowerSaveBlockActive } from '@/electron/lib/power-save.js';
import { runEffectBoundary } from '@/electron/runtime.js';

export function registerPowerSaveHandlers(): void {
  ipcMain.handle('power-save:set-active', (_, active: boolean) =>
    runEffectBoundary(
      Effect.sync(() => setPowerSaveBlockActive(active)).pipe(
        Effect.catchAll(() => Effect.void)
      )
    )
  );
}
