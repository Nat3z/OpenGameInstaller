// Utility function to safely serialize data and remove Proxy wrapping
function safeSerialize(data) {
    if (data === null || data === undefined) {
        return data;
    }
    try {
        // Use JSON.parse(JSON.stringify()) to deep clone and remove any Proxy wrapping
        return JSON.parse(JSON.stringify(data));
    }
    catch (error) {
        console.warn('Failed to serialize task data, returning as-is:', error);
        return data;
    }
}
export class DeferrableTask {
    task;
    finished = false;
    data = null;
    id = Math.random().toString(36).substring(7);
    addonOwner = '';
    logs = [];
    progress = 0;
    failed = undefined;
    constructor(task, addonOwner) {
        this.task = task;
        this.addonOwner = addonOwner;
    }
    async run() {
        try {
            const result = await this.task();
            this.finished = true;
            // Serialize the data to ensure it can be sent over IPC
            this.data = safeSerialize(result);
            console.log('task finished', this.id);
        }
        catch (error) {
            this.failed = error instanceof Error ? error.message : String(error);
            this.data = null;
            this.finished = true;
        }
    }
    // Method to get serialized data (additional safety)
    getSerializedData() {
        return safeSerialize(this.data);
    }
}
// Singleton pattern to ensure DeferredTasks maintains state across imports
class DeferredTasksManager {
    static instance;
    tasks = {};
    constructor() { }
    static getInstance() {
        if (!DeferredTasksManager.instance) {
            DeferredTasksManager.instance = new DeferredTasksManager();
        }
        return DeferredTasksManager.instance;
    }
    getTasks() {
        return this.tasks;
    }
    addTask(task) {
        this.tasks[task.id] = task;
    }
    removeTask(id) {
        delete this.tasks[id];
    }
}
// Export the tasks object as a getter to maintain backward compatibility
export const DeferredTasks = DeferredTasksManager.getInstance();
// Also export with the old misspelled name for backward compatibility
export const DefferedTasks = DeferredTasks;
//# sourceMappingURL=DeferrableTask.js.map