/**
 * Frontend API for cloud save: invoke IPC for config and sync, subscribe to status.
 */

export type CloudSaveConfig = {
  enabled: boolean;
  perGame: Record<
    string,
    { enabled: boolean; paths: { name: string; path: string }[] }
  >;
};

export type CloudSaveStatusPayload =
  | { appID: number; status: 'syncing-down'; progress?: number }
  | { appID: number; status: 'syncing-up'; progress?: number }
  | { appID: number; status: 'down-complete' }
  | { appID: number; status: 'up-complete' }
  | { appID: number; status: 'error'; message: string };

export async function getCloudSaveConfig(): Promise<CloudSaveConfig> {
  return window.electronAPI.cloudsave.getConfig();
}

export async function setCloudSaveConfig(config: CloudSaveConfig): Promise<void> {
  return window.electronAPI.cloudsave.setConfig(config);
}

export async function getLastSync(appID: number): Promise<{
  up?: number;
  down?: number;
} | null> {
  return window.electronAPI.cloudsave.getLastSync(appID);
}

export async function syncDown(
  appID: number
): Promise<{ success: boolean; error?: string }> {
  return window.electronAPI.cloudsave.syncDown(appID);
}

export async function syncUp(
  appID: number
): Promise<{ success: boolean; error?: string }> {
  return window.electronAPI.cloudsave.syncUp(appID);
}

export async function isCloudSaveEnabledForApp(appID: number): Promise<boolean> {
  return window.electronAPI.cloudsave.isEnabledForApp(appID);
}

export function subscribeCloudSaveStatus(
  callback: (payload: CloudSaveStatusPayload) => void
): () => void {
  const handler = (e: Event) => {
    if (e instanceof CustomEvent) callback(e.detail as CloudSaveStatusPayload);
  };
  document.addEventListener('cloudsave:status', handler);
  return () => document.removeEventListener('cloudsave:status', handler);
}
