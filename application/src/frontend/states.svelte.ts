import { createLogger, LOGGER_PREFIXES } from '@ogi-sdk/logger';

const logger = createLogger(LOGGER_PREFIXES.frontend);
type RequiredReadd = {
  appID: number;
  steamAppId?: number;
};

type DismissedUpdate = {
  appID: number;
  updateVersion: string;
};

// Load persisted update state from filesystem
export function loadPersistedUpdateState(): {
  requiredReadds: RequiredReadd[];
  dismissedUpdates: DismissedUpdate[];
} {
  try {
    if (typeof window !== 'undefined' && window.electronAPI?.fs) {
      // Ensure internals directory exists
      if (!window.electronAPI.fs.exists('./internals')) {
        window.electronAPI.fs.mkdir('./internals');
      }

      const statePath = './internals/update-state.json';
      if (window.electronAPI.fs.exists(statePath)) {
        const stored = window.electronAPI.fs.read(statePath);
        if (stored) {
          const parsed = JSON.parse(stored);
          const requiredReadds = Array.isArray(parsed.requiredReadds)
            ? parsed.requiredReadds
                .filter((v: unknown): v is RequiredReadd => {
                  if (typeof v !== 'object' || v === null) return false;
                  const record = v as Record<string, unknown>;
                  return (
                    typeof record.appID === 'number' &&
                    (record.steamAppId === undefined ||
                      typeof record.steamAppId === 'number')
                  );
                })
                .map((entry: RequiredReadd) => ({
                  appID: entry.appID,
                  steamAppId:
                    entry.steamAppId && entry.steamAppId !== 0
                      ? entry.steamAppId
                      : undefined,
                }))
            : [];
          const dismissedUpdates = Array.isArray(parsed.dismissedUpdates)
            ? parsed.dismissedUpdates.filter(
                (v: unknown): v is DismissedUpdate => {
                  return (
                    typeof v === 'object' &&
                    v !== null &&
                    typeof (v as Record<string, unknown>).appID === 'number' &&
                    typeof (v as Record<string, unknown>).updateVersion ===
                      'string'
                  );
                }
              )
            : [];
          return { requiredReadds, dismissedUpdates };
        }
      }
    }
  } catch (e) {
    logger.sync.error('Failed to load persisted update state:', e);
  }
  return { requiredReadds: [], dismissedUpdates: [] };
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

let initTimeout = true;
$effect.root(() => {
  $effect(() => {
    // Track the value to persist
    const requiredReadds = appUpdates.requiredReadds;
    const dismissedUpdates = appUpdates.dismissedUpdates;

    // Handle async work with proper cleanup
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const persistState = async () => {
      if (initTimeout) {
        await new Promise<void>((resolve) => {
          timeoutId = setTimeout(() => {
            timeoutId = null;
            resolve();
          }, 1000);
        });
        if (cancelled) return;
        initTimeout = false;
      }

      if (cancelled) return;

      try {
        if (typeof window !== 'undefined' && window.electronAPI?.fs) {
          // Ensure internals directory exists
          if (!window.electronAPI.fs.exists('./internals')) {
            window.electronAPI.fs.mkdir('./internals');
          }

          const stateToSave = {
            requiredReadds,
            dismissedUpdates,
          };
          window.electronAPI.fs.write(
            './internals/update-state.json',
            JSON.stringify(stateToSave, null, 2)
          );
        }
      } catch (e) {
        logger.sync.error('Failed to persist update state:', e);
      }
    };

    persistState();

    // Cleanup function - clears timeout if effect re-runs before timeout completes
    return () => {
      cancelled = true;
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
    };
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
  setCheckingAppUpdates: (appIDs: number[]) => {
    appUpdates.checkingApps = appIDs;
  },
  finishAppUpdateCheck: (appID: number) => {
    appUpdates.checkingApps = appUpdates.checkingApps.filter(
      (id) => id !== appID
    );
  },
  isCheckingAppUpdate: (appID: number) => {
    return appUpdates.checkingApps.includes(appID);
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
