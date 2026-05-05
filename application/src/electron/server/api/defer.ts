import { z } from 'zod';
import { addonServer } from '@/electron/server/addon-server.js';
import {
  type Procedure,
  procedure,
  ProcedureError,
  ProcedureJSON,
} from '@/electron/server/ipc.js';

export type ResponseDeferredTask = {
  id: string;
  addonOwner: string;
  finished: boolean;
  progress: number;
  logs: string[];
  failed: string | undefined;
};

const procedures: Record<string, Procedure<any>> = {
  // Get all deferred tasks
  getAllTasks: procedure()
    .input(z.object({}))
    .handler(async () => {
      const tasks: ResponseDeferredTask[] = Object.values(
        addonServer.getDeferredTasksManager().getTasks()
      ).map((task) => ({
        name: `Task ${task.id}`,
        description: 'Background task',
        id: task.id,
        addonOwner: task.addonOwner,
        finished: task.finished,
        progress: task.progress,
        logs: task.logs,
        failed: task.failed,
      }));

      return new ProcedureJSON(200, tasks);
    }),

  // Get specific task by ID
  getTask: procedure()
    .input(
      z.object({
        taskID: z.string(),
      })
    )
    .handler(async (input) => {
      const deferredTasksManager = addonServer.getDeferredTasksManager();
      if (deferredTasksManager.getTasks()[input.taskID] === undefined) {
        console.log(
          'task not found @' + input.taskID + '@',
          deferredTasksManager.getTasks()
        );
        return new ProcedureError(404, 'Task not found');
      }

      const task = deferredTasksManager.getTasks()[input.taskID]!!;

      // check if the addon is still running
      const stillExists = addonServer.getClient(task.addonOwner) !== undefined;
      // when the addon owner is *, we don't need to check if it's still connected as it's a global task spawned by the server
      if (!stillExists && task.addonOwner !== '*') {
        deferredTasksManager.removeTask(input.taskID);
        return new ProcedureError(410, 'Addon is no longer connected');
      }

      if (task.failed) {
        deferredTasksManager.removeTask(input.taskID);
        return new ProcedureError(500, task.failed);
      }

      if (task.finished) {
        deferredTasksManager.removeTask(input.taskID);
        // Use the getSerializedData method to ensure data is properly serialized
        return new ProcedureJSON(200, {
          data: task.getSerializedData(),
          resolved: true,
        });
      } else {
        return new ProcedureJSON(200, {
          progress: task.progress,
          logs: task.logs,
          failed: task.failed,
          resolved: false,
        });
      }
    }),
};

export default procedures;
