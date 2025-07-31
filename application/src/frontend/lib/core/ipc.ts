interface ConsumableRequest {
  consume?: 'json' | 'text';
  onProgress?: (progress: number) => void;
  onLogs?: (logs: string[]) => void;
  onFailed?: (error: string) => void;
  onTaskStarted?: (taskID: string) => void;
}
export async function safeFetch(
  method: string,
  params: any,
  options: ConsumableRequest = { consume: 'json' }
) {
  console.log(method, params);
  return new Promise<any>((resolve, reject) => {
    // remove the functions on the options object
    const fetchOptions = { ...options };
    delete fetchOptions.consume;
    delete fetchOptions.onProgress;
    delete fetchOptions.onLogs;
    delete fetchOptions.onFailed;
    window.electronAPI.app.request(method, params).then((response) => {
      if (response.error) {
        reject(response.error);
        return;
      }
      if (response.taskID) {
        const taskID = response.taskID;
        if (options.onTaskStarted) options.onTaskStarted(taskID);
        // if the task is deferred, we should poll the task until it's done.
        const deferInterval = setInterval(async () => {
          const taskResponse = await window.electronAPI.app.request('getTask', {
            taskID,
          });
          if (taskResponse.status === 404) {
            reject('Task not found when deferring.');
            if (options.onFailed)
              options.onFailed('Task not found when deferring.');
            clearInterval(deferInterval);
          } else if (taskResponse.status === 410) {
            reject('Addon is no longer connected');
            if (options.onFailed)
              options.onFailed('Addon is no longer connected');
            clearInterval(deferInterval);
          } else if (taskResponse.status !== 200) {
            console.log('Task failed', taskResponse);
            if (options.onFailed)
              options.onFailed(taskResponse.error ?? 'Task failed');
            clearInterval(deferInterval);
            reject(taskResponse.error ?? 'Task failed');
            return;
          }
          if (
            taskResponse.data &&
            taskResponse.data.data &&
            taskResponse.data.data.progress === undefined
          ) {
            // Task is completed
            clearInterval(deferInterval);
            if (!options || !options.consume || options.consume === 'json')
              return resolve(
                JSON.parse(JSON.stringify(taskResponse.data.data))
              );
            else if (options.consume === 'text')
              return resolve(taskResponse.data.data);
            else throw new Error('Invalid consume type');
          }
          if (taskResponse.data) {
            // Task is still running
            const taskData: {
              progress: number;
              logs: string[];
              failed: string | undefined;
            } = taskResponse.data;
            if (options.onProgress && taskData.progress !== undefined)
              options.onProgress(taskData.progress);
            if (options.onLogs && taskData.logs !== undefined)
              options.onLogs(taskData.logs);
            if (options.onFailed && taskData.failed)
              options.onFailed(taskData.failed);
          }
        }, 50);
      } else {
        if (!options || !options.consume || options.consume === 'json')
          return resolve(response.data);
        else if (options.consume === 'text') return resolve(response.data);
        else throw new Error('Invalid consume type');
      }
    });
  });
}
