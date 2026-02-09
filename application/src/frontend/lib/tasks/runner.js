import { createNotification, deferredTasks } from '../../store';
import { safeFetch } from '../core/ipc';
export async function runTask(result, originalFilePath, libraryInfo) {
    let taskID;
    const args = {
        addonID: result.addonSource,
        manifest: JSON.parse(JSON.stringify(result.manifest || {})),
        downloadPath: originalFilePath,
        name: result.name,
    };
    // Include libraryInfo if provided
    if (libraryInfo) {
        args.libraryInfo = JSON.parse(JSON.stringify(libraryInfo));
    }
    // If this is a task-type result, include the taskName
    if (result.downloadType === 'task') {
        args.taskName = result.taskName;
        // Also ensure manifest has __taskName for backward compatibility
        args.manifest = {
            ...args.manifest,
            __taskName: result.taskName,
        };
    }
    const response = await safeFetch('runTask', args, {
        consume: 'json',
        onTaskStarted: (newTaskId) => {
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
                message: 'Task started. You can view the progress in the Notifications tab.',
            });
        },
        onLogs: (logs) => {
            if (!taskID)
                return;
            deferredTasks.update((tasks) => tasks.map((t) => (t.id === taskID ? { ...t, logs } : t)));
        },
        onProgress: (progress) => {
            if (!taskID)
                return;
            deferredTasks.update((tasks) => tasks.map((t) => (t.id === taskID ? { ...t, progress } : t)));
        },
        onFailed: (error) => {
            if (!taskID)
                return;
            deferredTasks.update((tasks) => tasks.map((t) => (t.id === taskID ? { ...t, failed: error } : t)));
            createNotification({
                id: Math.random().toString(36).substring(7),
                type: 'error',
                message: error,
            });
        },
    });
    deferredTasks.update((tasks) => tasks.filter((t) => t.id !== taskID));
    createNotification({
        id: Math.random().toString(36).substring(7),
        type: 'success',
        message: 'Task completed',
    });
    return response;
}
//# sourceMappingURL=runner.js.map