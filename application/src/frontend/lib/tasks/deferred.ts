import type { DeferredTaskSnapshot } from '@ogi-sdk/client-kit';
import { addonServer } from '@/frontend/lib/core/ipc';
import {
  deferredTasks,
  removedTasks,
  type DeferredTask,
} from '@/frontend/store.svelte';

export async function loadDeferredTasks(tasksToRemove: string[] = []) {
  try {
    const tasks = await addonServer.getDeferredTasks();
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
          // Only surface an explicit failure message as the task error. Logs are
          // shown separately and should not be promoted to errors.
          error: task.failed || undefined,
          type: 'other',
        }))
    );
  } catch (error) {
    console.error('Error loading deferred tasks:', error);
  }
}

export async function cancelTask(taskId: string) {
  try {
    // Note: Cancel functionality is not implemented in the defer API
    // Tasks cannot be cancelled once started
    console.warn('Task cancellation is not supported');

    // Optionally remove the task from the local state
    deferredTasks.update((tasks: DeferredTask[]) =>
      tasks.filter((task: DeferredTask) => task.id !== taskId)
    );
  } catch (error) {
    console.error('Error cancelling task:', error);
  }
}

export function clearCompletedTasks() {
  deferredTasks.update((tasks: DeferredTask[]) =>
    tasks.filter(
      (task: DeferredTask) =>
        task.status !== 'completed' &&
        task.status !== 'error' &&
        task.status !== 'cancelled'
    )
  );
}

export function clearAllTasks(tasks: string[]) {
  removedTasks.update((removedTasks: string[]) =>
    [...removedTasks, ...tasks].filter(
      (task, index, self) => self.indexOf(task) === index
    )
  );
  deferredTasks.update((deferredTasks: DeferredTask[]) =>
    deferredTasks.filter((task: DeferredTask) => !tasks.includes(task.id))
  );
}
