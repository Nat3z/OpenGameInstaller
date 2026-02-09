import { deferredTasks, removedTasks } from '../../store';
export async function loadDeferredTasks(tasksToRemove = []) {
    try {
        const response = await window.electronAPI.app.request('getAllTasks', {});
        if (response.status === 200) {
            const tasks = response.data;
            deferredTasks.set(tasks
                .filter((task) => !tasksToRemove.includes(task.id))
                .map((task) => ({
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
            })));
        }
    }
    catch (error) {
        console.error('Error loading deferred tasks:', error);
    }
}
export async function cancelTask(taskId) {
    try {
        // Note: Cancel functionality is not implemented in the defer API
        // Tasks cannot be cancelled once started
        console.warn('Task cancellation is not supported');
        // Optionally remove the task from the local state
        deferredTasks.update((tasks) => tasks.filter((task) => task.id !== taskId));
    }
    catch (error) {
        console.error('Error cancelling task:', error);
    }
}
export function clearCompletedTasks() {
    deferredTasks.update((tasks) => tasks.filter((task) => task.status !== 'completed' &&
        task.status !== 'error' &&
        task.status !== 'cancelled'));
}
export function clearAllTasks(tasks) {
    removedTasks.update((removedTasks) => [...removedTasks, ...tasks].filter((task, index, self) => self.indexOf(task) === index));
    deferredTasks.update((deferredTasks) => deferredTasks.filter((task) => !tasks.includes(task.id)));
}
//# sourceMappingURL=deferred.js.map