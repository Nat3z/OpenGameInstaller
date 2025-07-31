import type { SearchResult } from 'ogi-addon';
import { createNotification, deferredTasks } from '../../store';
import { safeFetch } from '../core/ipc';

export type SearchResultWithAddon = SearchResult & {
  addonSource: string;
  capsuleImage: string;
  coverImage: string;
  storefront: string;
};

export async function runTask(
  result: SearchResultWithAddon,
  originalFilePath: string
) {
  let taskID: string;
  const response = await safeFetch(
    'runTask',
    {
      addonID: result.addonSource,
      manifest: JSON.parse(JSON.stringify(result.manifest)),
      downloadPath: originalFilePath,
      name: result.name,
    },
    {
      consume: 'json',
      onTaskStarted: (newTaskId: string) => {
        taskID = newTaskId;
        deferredTasks.update((tasks) => [
          ...tasks,
          {
            id: taskID,
            name: `Task: ${result.name}`,
            description: 'Running task',
            addonOwner: result.addonSource,
            status: 'running',
            progress: 0,
            logs: [],
            timestamp: Date.now(),
            type: 'other',
            failed: undefined,
          },
        ]);
        createNotification({
          id: Math.random().toString(36).substring(7),
          type: 'info',
          message:
            'Task started. You can view the progress the Notifications tab.',
        });
      },
      onLogs: (logs: string[]) => {
        if (!taskID) return;
        deferredTasks.update((tasks) =>
          tasks.map((t) => (t.id === taskID ? { ...t, logs } : t))
        );
      },
      onProgress: (progress: number) => {
        if (!taskID) return;
        deferredTasks.update((tasks) =>
          tasks.map((t) => (t.id === taskID ? { ...t, progress } : t))
        );
      },
      onFailed: (error: string) => {
        if (!taskID) return;
        deferredTasks.update((tasks) =>
          tasks.map((t) => (t.id === taskID ? { ...t, failed: error } : t))
        );
        createNotification({
          id: Math.random().toString(36).substring(7),
          type: 'error',
          message: error,
        });
      },
    }
  );

  deferredTasks.update((tasks) => tasks.filter((t) => t.id !== taskID));

  return response;
}
