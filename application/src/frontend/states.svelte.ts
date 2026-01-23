export let appUpdates = $state({
  apps: [] as {
    appID: number;
    name: string;
    updateAvailable: boolean;
    updateVersion: string;
  }[],
  requiredReadds: [] as number[],
  prefixMoveInfo: {} as Record<number, { originalPrefix: string; gameName: string }>,
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
