export async function safeFetch(method, params, options = { consume: 'json' }) {
    console.log(method, params);
    return new Promise((resolve, reject) => {
        let settled = false;
        let failedNotified = false;
        // remove the functions on the options object
        const fetchOptions = { ...options };
        delete fetchOptions.consume;
        delete fetchOptions.onProgress;
        delete fetchOptions.onLogs;
        delete fetchOptions.onFailed;
        window.electronAPI.app.request(method, params).then((response) => {
            if (response.error) {
                if (!settled) {
                    settled = true;
                    reject(response.error);
                }
                return;
            }
            if (response.taskID) {
                const taskID = response.taskID;
                if (options.onTaskStarted)
                    options.onTaskStarted(taskID);
                // if the task is deferred, we should poll the task until it's done.
                const deferInterval = setInterval(async () => {
                    if (settled) {
                        clearInterval(deferInterval);
                        return;
                    }
                    const taskResponse = await window.electronAPI.app.request('getTask', {
                        taskID,
                    });
                    if (taskResponse.status === 404) {
                        if (!settled) {
                            settled = true;
                            reject('Task not found when deferring.');
                        }
                        console.log('Task failed');
                        if (options.onFailed)
                            options.onFailed('Task not found when deferring.');
                        clearInterval(deferInterval);
                    }
                    else if (taskResponse.status === 410) {
                        if (!settled) {
                            settled = true;
                            reject('Addon is no longer connected');
                        }
                        if (options.onFailed)
                            options.onFailed('Addon is no longer connected');
                        clearInterval(deferInterval);
                    }
                    else if (taskResponse.status !== 200) {
                        console.log('Task failed', taskResponse);
                        if (options.onFailed && !failedNotified)
                            options.onFailed(taskResponse.error ?? 'Task failed');
                        failedNotified = true;
                        clearInterval(deferInterval);
                        if (!settled) {
                            settled = true;
                            reject(taskResponse.error ?? 'Task failed');
                        }
                        return;
                    }
                    if (taskResponse.data.resolved ||
                        (taskResponse.data && taskResponse.data.data !== undefined)) {
                        clearInterval(deferInterval);
                        if (!settled) {
                            settled = true;
                            if (taskResponse.data.data === undefined) {
                                return resolve(undefined);
                            }
                            if ((!options || !options.consume || options.consume === 'json') &&
                                taskResponse.data.data)
                                return resolve(JSON.parse(JSON.stringify(taskResponse.data.data)));
                            else if (options.consume === 'text')
                                return resolve(taskResponse.data.data);
                            else
                                throw new Error('Invalid consume type');
                        }
                    }
                    if (taskResponse.data) {
                        // Task is still running
                        const taskData = taskResponse.data;
                        if (options.onProgress && taskData.progress !== undefined)
                            options.onProgress(taskData.progress);
                        if (options.onLogs && taskData.logs !== undefined)
                            options.onLogs(taskData.logs);
                        if (taskData.failed) {
                            if (options.onFailed && !failedNotified) {
                                failedNotified = true;
                                options.onFailed(taskData.failed);
                            }
                            clearInterval(deferInterval);
                            if (!settled) {
                                settled = true;
                                reject(taskData.failed);
                            }
                        }
                    }
                }, 50);
            }
            else {
                if (!settled) {
                    settled = true;
                    if (!options || !options.consume || options.consume === 'json')
                        return resolve(response.data);
                    else if (options.consume === 'text')
                        return resolve(response.data);
                    else
                        throw new Error('Invalid consume type');
                }
            }
        });
    });
}
//# sourceMappingURL=ipc.js.map