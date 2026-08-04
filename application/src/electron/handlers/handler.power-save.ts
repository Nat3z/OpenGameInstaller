import { Effect } from 'effect';
import { setPowerSaveBlockActive } from '@/electron/lib/power-save.js';
import { electronIpcMain } from '@/electron/rpc/handlers.js';
import { runEffectBoundary } from '@/electron/runtime.js';

export function registerPowerSaveHandlers(): void {
  electronIpcMain.handle('power-save:set-active', (_, active: boolean) =>
    runEffectBoundary(
      Effect.sync(() => setPowerSaveBlockActive(active)).pipe(
        Effect.catchAll(() => Effect.void)
      )
    )
  );
}
