type RequiredReadd = {
  appID: number;
  steamAppId: number;
};

// Load persisted update state from filesystem
export function loadPersistedUpdateState(): {
  requiredReadds: RequiredReadd[];
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
          if (Array.isArray(parsed.requiredReadds)) {
            const requiredReadds = parsed.requiredReadds.filter(
              (v: unknown): v is RequiredReadd => {
                return (
                  typeof v === 'object' &&
                  v !== null &&
                  typeof (v as any).appID === 'number' &&
                  typeof (v as any).steamAppId === 'number'
                );
              }
            );
            return { requiredReadds };
          }
        }
      }
    }
  } catch (e) {
    console.error('Failed to load persisted update state:', e);
  }
  return { requiredReadds: [] };
}

export let appUpdates = $state({
  apps: [] as {
    appID: number;
    name: string;
    updateAvailable: boolean;
    updateVersion: string;
  }[],
  requiredReadds: [] as RequiredReadd[],
});

let initTimeout = true;
$effect.root(() => {
  $effect(() => {
    // Track the value to persist
    const requiredReadds = appUpdates.requiredReadds;

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
          };
          window.electronAPI.fs.write(
            './internals/update-state.json',
            JSON.stringify(stateToSave, null, 2)
          );
        }
      } catch (e) {
        console.error('Failed to persist update state:', e);
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

export let gameUpdatesCheckState = $state({
  isChecking: false,
  lastResult: null as { updatesFound: number } | null,
});

export const updatesManager = {
  clearAppUpdates: () => {
    appUpdates.apps = [];
  },
  setCheckingForGameUpdates: (value: boolean) => {
    gameUpdatesCheckState.isChecking = value;
  },
  setLastGameUpdatesCheckResult: (
    result: { updatesFound: number } | null
  ) => {
    gameUpdatesCheckState.lastResult = result;
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
    appUpdates.apps.push({ appID, name, updateAvailable, updateVersion });
  },
  removeAppUpdate: (appID: number) => {
    appUpdates.apps = appUpdates.apps.filter((app) => app.appID !== appID);
  },
  getAppUpdate: (appID: number) => {
    return appUpdates.apps.find((app) => app.appID === appID);
  },
};

export const settingUpPrefix = $state({
  appIds: [] as number[],
});
