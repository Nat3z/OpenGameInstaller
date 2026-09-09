import { createLogger, LOGGER_PREFIXES } from '@ogi-sdk/logger';
import { Effect } from 'effect';
import { runDetached } from '@/frontend/lib/core/runtime';
import { electronRpc } from '@/frontend/lib/electron-rpc';
import type { DismissedUpdate, RequiredReadd } from '@/lib/state';

const logger = createLogger(LOGGER_PREFIXES.frontend);

let persistenceReady = false;

/** Loads the persisted update state; persistence starts once it is loaded. */
export function loadPersistedUpdateState() {
  return electronRpc.state.getUpdateState().pipe(
    Effect.tap((state) =>
      Effect.sync(() => {
        appUpdates.requiredReadds = state.requiredReadds;
        appUpdates.dismissedUpdates = state.dismissedUpdates;
        persistenceReady = true;
      })
    ),
    Effect.tapError((error) =>
      logger.error('Failed to load persisted update state:', error)
    )
  );
}

export let appUpdates = $state({
  apps: [] as {
    appID: number;
    name: string;
    updateAvailable: boolean;
    updateVersion: string;
  }[],
  requiredReadds: [] as RequiredReadd[],
  dismissedUpdates: [] as DismissedUpdate[],
  // appIDs currently awaiting a check-for-updates response from an addon
  checkingApps: [] as number[],
  // true while a sweep is still resolving which games are checkable,
  // so games don't show as playable before their check even starts
  updateSweepResolving: false,
});

export function queueRequiredReadd(appID: number, steamAppId?: number): void {
  appUpdates.requiredReadds = [
    ...appUpdates.requiredReadds.filter((entry) => entry.appID !== appID),
    { appID, steamAppId },
  ];
}

export function getRequiredReadd(appID: number): RequiredReadd | undefined {
  return appUpdates.requiredReadds.find((entry) => entry.appID === appID);
}

export function completeRequiredReadd(appID: number): void {
  appUpdates.requiredReadds = appUpdates.requiredReadds.filter(
    (entry) => entry.appID !== appID
  );
}

$effect.root(() => {
  $effect(() => {
    const requiredReadds = appUpdates.requiredReadds;
    const dismissedUpdates = appUpdates.dismissedUpdates;
    // Never persist the empty initial state over what is on disk.
    if (!persistenceReady) return;
    runDetached(
      electronRpc.state.setUpdateState({ requiredReadds, dismissedUpdates }),
      'Failed to persist update state'
    );
  });
});

export const updatesManager = {
  clearAppUpdates: () => {
    appUpdates.apps = [];
  },
  addAppUpdate: ({
    appID,
    name,
    updateAvailable,
    updateVersion,
  }: {
    appID: number;
    name: string;
    updateAvailable: boolean;
    updateVersion: string;
  }) => {
    appUpdates.apps = [
      ...appUpdates.apps.filter((app) => app.appID !== appID),
      { appID, name, updateAvailable, updateVersion },
    ];
    appUpdates.dismissedUpdates = appUpdates.dismissedUpdates.filter(
      (dismissed) =>
        dismissed.appID !== appID || dismissed.updateVersion === updateVersion
    );
  },
  removeAppUpdate: (appID: number) => {
    appUpdates.apps = appUpdates.apps.filter((app) => app.appID !== appID);
    appUpdates.dismissedUpdates = appUpdates.dismissedUpdates.filter(
      (dismissed) => dismissed.appID !== appID
    );
  },
  getAppUpdate: (appID: number) => {
    return appUpdates.apps.find((app) => app.appID === appID);
  },
  beginAppUpdateSweep: () => {
    appUpdates.updateSweepResolving = true;
  },
  setCheckingAppUpdates: (appIDs: number[]) => {
    appUpdates.checkingApps = appIDs;
    appUpdates.updateSweepResolving = false;
  },
  finishAppUpdateCheck: (appID: number) => {
    appUpdates.checkingApps = appUpdates.checkingApps.filter(
      (id) => id !== appID
    );
  },
  isCheckingAppUpdate: (appID: number) => {
    return (
      appUpdates.updateSweepResolving || appUpdates.checkingApps.includes(appID)
    );
  },
  dismissAppUpdate: (appID: number, updateVersion: string) => {
    if (
      appUpdates.dismissedUpdates.some(
        (dismissed) =>
          dismissed.appID === appID && dismissed.updateVersion === updateVersion
      )
    ) {
      return;
    }
    appUpdates.dismissedUpdates = [
      ...appUpdates.dismissedUpdates,
      { appID, updateVersion },
    ];
  },
  clearDismissedAppUpdate: (appID: number) => {
    appUpdates.dismissedUpdates = appUpdates.dismissedUpdates.filter(
      (dismissed) => dismissed.appID !== appID
    );
  },
  isAppUpdateDismissed: (appID: number, updateVersion: string) => {
    return appUpdates.dismissedUpdates.some(
      (dismissed) =>
        dismissed.appID === appID && dismissed.updateVersion === updateVersion
    );
  },
};

export const settingUpPrefix = $state({
  appIds: [] as number[],
});
