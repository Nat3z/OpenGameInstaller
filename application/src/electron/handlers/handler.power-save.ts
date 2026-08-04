import { Effect } from 'effect';
import { setPowerSaveBlockActive } from '@/electron/lib/power-save.js';
import { procedure, router } from '@/electron/rpc/router-core.js';
import { runEffectBoundary } from '@/electron/runtime.js';
import { ElectronRpc } from '@/lib/electron-rpc.js';

export function registerPowerSaveHandlers() {
  return router(
    procedure(ElectronRpc.powerSave.setActive, (active: boolean) =>
      runEffectBoundary(
        Effect.sync(() => setPowerSaveBlockActive(active)).pipe(
          Effect.catchAll(() => Effect.void)
        )
      )
    )
  );
}
