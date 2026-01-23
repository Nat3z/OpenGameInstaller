// Load persisted update state from filesystem
export function loadPersistedUpdateState(): {
  requiredReadds: number[];
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
          return {
            requiredReadds: Array.isArray(parsed.requiredReadds)
              ? parsed.requiredReadds.filter(
                  (v: unknown): v is number =>
                    typeof v === 'number' && Number.isFinite(v)
                )
              : [],
          };
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
  requiredReadds: [] as number[],
});

// Persist requiredReadds to filesystem whenever it changes
$effect.root(() => {
  $effect(() => {
    // Track the value to persist
    const requiredReadds = appUpdates.requiredReadds;

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
