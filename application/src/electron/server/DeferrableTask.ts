// Utility function to safely serialize data and remove Proxy wrapping
function safeSerialize<T>(data: T): T {
  if (data === null || data === undefined) {
    return data;
  }
  try {
    // Use JSON.parse(JSON.stringify()) to deep clone and remove any Proxy wrapping
    return JSON.parse(JSON.stringify(data));
  } catch (error) {
    console.warn('Failed to serialize task data, returning as-is:', error);
    return data;
  }
}

export class DeferrableTask<T> {
  private task: () => Promise<any>;
  public finished: boolean = false;

  public data: T | null;
  public id: string = Math.random().toString(36).substring(7);
  public addonOwner = '';
  public logs: string[] = [];
  public progress = 0;
  public failed: string | undefined = undefined;
  constructor(task: () => Promise<T>, addonOwner: string) {
    this.task = task;
    this.addonOwner = addonOwner;
  }

  public async run() {
    try {
      const result = await this.task();
      this.finished = true;
      // Serialize the data to ensure it can be sent over IPC
      this.data = safeSerialize(result);
      console.log('task finished', this.id, this.data);
    } catch (error) {
      this.failed = error;
      this.data = null;
      this.finished = true;
    }
  }

  // Method to get serialized data (additional safety)
  public getSerializedData(): T | null {
    return safeSerialize(this.data);
  }
}

// Singleton pattern to ensure DeferredTasks maintains state across imports
class DeferredTasksManager {
  private static instance: DeferredTasksManager;
  private tasks: Record<string, DeferrableTask<any>> = {};

  private constructor() {}

  public static getInstance(): DeferredTasksManager {
    if (!DeferredTasksManager.instance) {
      DeferredTasksManager.instance = new DeferredTasksManager();
    }
    return DeferredTasksManager.instance;
  }

  public getTasks(): Record<string, DeferrableTask<any>> {
    return this.tasks;
  }

  public addTask(task: DeferrableTask<any>) {
    this.tasks[task.id] = task;
  }

  public removeTask(id: string) {
    delete this.tasks[id];
  }
}

// Export the tasks object as a getter to maintain backward compatibility
export const DeferredTasks = DeferredTasksManager.getInstance();

// Also export with the old misspelled name for backward compatibility
export const DefferedTasks = DeferredTasks;
