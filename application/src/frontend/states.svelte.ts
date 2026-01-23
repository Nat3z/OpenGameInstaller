// Load persisted update state from filesystem
function loadPersistedUpdateState(): {
  requiredReadds: number[];
  prefixMoveInfo: Record<number, { originalPrefix: string; gameName: string }>;
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
              ? parsed.requiredReadds
              : [],
            prefixMoveInfo:
              parsed.prefixMoveInfo && typeof parsed.prefixMoveInfo === 'object'
                ? parsed.prefixMoveInfo
                : {},
          };
        }
      }
    }
  } catch (e) {
    console.error('Failed to load persisted update state:', e);
  }
  return { requiredReadds: [], prefixMoveInfo: {} };
}

const persistedState = loadPersistedUpdateState();

export let appUpdates = $state({
  apps: [] as {
    appID: number;
    name: string;
    updateAvailable: boolean;
    updateVersion: string;
  }[],
  requiredReadds: persistedState.requiredReadds as number[],
  prefixMoveInfo: persistedState.prefixMoveInfo as Record<
    number,
    { originalPrefix: string; gameName: string }
  >,
});

// Persist requiredReadds and prefixMoveInfo to filesystem whenever they change
$effect.root(() => {
  $effect(() => {
    // Track the values to persist
    const requiredReadds = appUpdates.requiredReadds;
    const prefixMoveInfo = appUpdates.prefixMoveInfo;

    try {
      if (typeof window !== 'undefined' && window.electronAPI?.fs) {
        // Ensure internals directory exists
        if (!window.electronAPI.fs.exists('./internals')) {
          window.electronAPI.fs.mkdir('./internals');
        }

        const stateToSave = {
          requiredReadds,
          prefixMoveInfo,
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
