import { Effect } from 'effect';
import type { BrowserWindow } from 'electron';
import { procedure, router } from '@/electron/rpc/router-core.js';
import { runEffectBoundary } from '@/electron/runtime.js';
import {
  abortManagedSetup,
  beginManagedSetup,
  completeManagedSetup,
  extractManagedDownload,
  finishManagedSetup,
  prepareDirectUpdate,
} from '@/electron/update-system/manager.js';
import {
  afterUpdateRecovery,
  startUpdateRecovery,
} from '@/electron/update-system/readiness.js';
import { recoverStaging } from '@/electron/update-system/staging.js';
import { recoverTransactions } from '@/electron/update-system/transaction.js';
import { ElectronRpc } from '@/lib/electron-rpc.js';

export default function UpdateSystemHandler(_mainWindow: BrowserWindow) {
  startUpdateRecovery(
    recoverTransactions().pipe(Effect.zipRight(recoverStaging()))
  );
  return router(
    procedure(ElectronRpc.update.prepareDirect, (input) =>
      runEffectBoundary(afterUpdateRecovery(prepareDirectUpdate(input)))
    ),
    procedure(ElectronRpc.update.extract, (input) =>
      runEffectBoundary(afterUpdateRecovery(extractManagedDownload(input)))
    ),
    procedure(ElectronRpc.update.beginSetup, (input) =>
      runEffectBoundary(afterUpdateRecovery(beginManagedSetup(input)))
    ),
    procedure(ElectronRpc.update.finishSetup, (input) =>
      runEffectBoundary(afterUpdateRecovery(finishManagedSetup(input)))
    ),
    procedure(ElectronRpc.update.completeSetup, (transactionId) =>
      runEffectBoundary(
        afterUpdateRecovery(completeManagedSetup(transactionId))
      )
    ),
    procedure(ElectronRpc.update.abortSetup, (transactionId) =>
      runEffectBoundary(afterUpdateRecovery(abortManagedSetup(transactionId)))
    )
  );
}
