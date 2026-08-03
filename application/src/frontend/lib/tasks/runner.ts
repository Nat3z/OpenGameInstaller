import { AddonError, formatError } from '@ogi/errors';
import type { LibraryInfo, SearchResult } from '@ogi-sdk/connect';
import { Effect, Exit } from 'effect';
import { get } from 'svelte/store';
import { addonServer } from '@/frontend/lib/core/ipc';
import { createNotification, deferredTasks } from '@/frontend/store.svelte';

export type SearchResultWithAddon = SearchResult & {
  addonSource: string;
  addonName: string;
  capsuleImage: string;
  coverImage: string;
  storefront: string;
  isUpdate?: boolean;
  updateVersion?: string;
  clearOldFilesBeforeUpdate?: boolean;
} & (
    | { downloadType: 'task'; taskName: string }
    | { downloadType?: 'torrent' | 'magnet' | 'direct' | 'request' | 'empty' }
  );

export function runTask(
  result: SearchResultWithAddon,
  originalFilePath: string,
  libraryInfo?: LibraryInfo
) {
  let taskID: string | undefined;
  return Effect.gen(function* () {
    const manifest = structuredClone(result.manifest ?? {}) as Record<
      string,
      unknown
    >;
    const args = {
      addonID: result.addonSource,
      manifest:
        result.downloadType === 'task'
          ? { ...manifest, __taskName: result.taskName }
          : manifest,
      downloadPath: originalFilePath,
      name: result.name,
      ...(result.downloadType === 'task' ? { taskName: result.taskName } : {}),
      ...(libraryInfo ? { libraryInfo: structuredClone(libraryInfo) } : {}),
    };

    const response = yield* Effect.tryPromise({
      try: () =>
        addonServer
          .addon(result.addonSource, {
            onTaskStarted: (id: string) => {
              taskID = id;
              deferredTasks.update((tasks) => [
                ...tasks,
                {
                  id,
                  name: `Task: ${result.name}`,
                  description: 'Running task',
                  addonOwner: result.addonSource,
                  status: 'running',
                  progress: 0,
                  logs: [],
                  timestamp: Date.now(),
                  type: 'other',
                },
              ]);
              createNotification({
                id: Math.random().toString(36).substring(7),
                type: 'info',
                message:
                  'Task started. You can view progress in the Notifications tab.',
              });
            },
            onLogs: (logs: string[]) => {
              if (!taskID) return;
              deferredTasks.update((tasks) =>
                tasks.map((task) =>
                  task.id === taskID ? { ...task, logs } : task
                )
              );
            },
            onProgress: (progress: number) => {
              if (!taskID) return;
              deferredTasks.update((tasks) =>
                tasks.map((task) =>
                  task.id === taskID ? { ...task, progress } : task
                )
              );
            },
            onFailed: (error: string) => {
              if (!taskID) return;
              deferredTasks.update((tasks) =>
                tasks.map((task) =>
                  task.id === taskID
                    ? { ...task, error, status: 'error' }
                    : task
                )
              );
              createNotification({
                id: Math.random().toString(36).substring(7),
                type: 'error',
                message: error,
              });
            },
          })
          .taskRun(args),
      catch: (cause) =>
        new AddonError({
          message: `Task failed: ${formatError(cause)}`,
          addonName: result.addonSource,
        }),
    });

    if (
      taskID &&
      get(deferredTasks).find((task) => task.id === taskID)?.status !== 'error'
    ) {
      deferredTasks.update((tasks) =>
        tasks.filter((task) => task.id !== taskID)
      );
      createNotification({
        id: Math.random().toString(36).substring(7),
        type: 'success',
        message: 'Task completed',
      });
    }
    return response;
  }).pipe(
    Effect.onExit((exit) =>
      Exit.isSuccess(exit) || !taskID
        ? Effect.void
        : Effect.sync(() => {
            deferredTasks.update((tasks) =>
              tasks.filter((task) => task.id !== taskID)
            );
          })
    )
  );
}
