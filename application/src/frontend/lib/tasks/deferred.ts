import type { ResponseDeferredTask } from '../../../electron/server/api/defer';
import { deferredTasks, removedTasks, type DeferredTask } from '../../store';

export async function loadDeferredTasks(tasksToRemove: string[] = []) {
  try {
    const response = await window.electronAPI.app.request('getAllTasks', {});

    if (response.status === 200) {
      const tasks = response.data as ResponseDeferredTask[];
      deferredTasks.set(
        tasks
          .filter(
            (task: ResponseDeferredTask) => !tasksToRemove.includes(task.id)
          )
          .map((task: ResponseDeferredTask) => ({
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
            failed: task.failed,
            logs: task.logs || [],
            timestamp: Date.now(),
            duration: undefined,
            error: task.failed || undefined,
            type: 'other',
          }))
      );
    }
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
  removedTasks.set(tasks);
  deferredTasks.update(() => []);
}
