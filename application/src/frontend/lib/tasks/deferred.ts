import type { DeferredTaskSnapshot } from '@ogi-sdk/client-kit';
import { AddonError, formatError } from '@ogi-sdk/errors';
import { createLogger, LOGGER_PREFIXES } from '@ogi-sdk/logger';
import { Effect } from 'effect';
import { addonServer } from '@/frontend/lib/core/ipc';
import {
  type DeferredTask,
  deferredTasks,
  removedTasks,
} from '@/frontend/store.svelte';

const logger = createLogger(LOGGER_PREFIXES.frontend);

export function loadDeferredTasks(tasksToRemove: string[] = []) {
  return Effect.tryPromise({
    try: () => addonServer.getDeferredTasks(),
    catch: (cause) =>
      new AddonError({
        message: `Failed to load deferred tasks: ${formatError(cause)}`,
      }),
  }).pipe(
    Effect.tap((tasks) =>
      Effect.sync(() => {
        deferredTasks.set(
          tasks
            .filter(
              (task: DeferredTaskSnapshot) => !tasksToRemove.includes(task.id)
            )
            .map((task: DeferredTaskSnapshot) => ({
              id: task.id,
              name: `Task ${task.id}`,
              description: 'Background task',
              addonOwner: task.addonOwner,
              status: task.finished
                ? task.failed
                  ? 'error'
                  : 'completed'
                : 'running',
              progress: task.progress || 0,
              logs: task.logs || [],
              timestamp: Date.now(),
              duration: undefined,
              error: task.failed || undefined,
              type: 'other',
            }))
        );
      })
    ),
    Effect.asVoid
  );
}

export function cancelTask(taskId: string): Effect.Effect<void> {
  return Effect.sync(() => {
    logger.sync.warn('Task cancellation is not supported');
    removedTasks.update((removed) =>
      removed.includes(taskId) ? removed : [...removed, taskId]
    );
    deferredTasks.update((tasks: DeferredTask[]) =>
      tasks.filter((task) => task.id !== taskId)
    );
  });
}

export function clearCompletedTasks(): void {
  deferredTasks.update((tasks: DeferredTask[]) =>
    tasks.filter(
      (task) =>
        task.status !== 'completed' &&
        task.status !== 'error' &&
        task.status !== 'cancelled'
    )
  );
}

export function clearAllTasks(tasks: string[]): void {
  removedTasks.update((removed) =>
    [...removed, ...tasks].filter(
      (task, index, self) => self.indexOf(task) === index
    )
  );
  deferredTasks.update((current) =>
    current.filter((task) => !tasks.includes(task.id))
  );
}
