import { z } from 'zod';
import { clients } from '../addon-server.js';
import { DeferredTasks } from '../DeferrableTask.js';
import {
  type Procedure,
  procedure,
  ProcedureError,
  ProcedureJSON,
} from '../serve.js';

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
        DeferredTasks.getTasks()
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
      console.log('x', DeferredTasks.getTasks());
      if (DeferredTasks.getTasks()[input.taskID] === undefined) {
        console.log('task not found @' + input.taskID + '@', DeferredTasks);
        return new ProcedureError(404, 'Task not found');
      }

      const task = DeferredTasks.getTasks()[input.taskID]!!;

      // check if the addon is still running
      const stillExists = clients.has(task.addonOwner);
      if (!stillExists) {
        DeferredTasks.removeTask(input.taskID);
        return new ProcedureError(410, 'Addon is no longer connected');
      }

      if (task.failed) {
        DeferredTasks.removeTask(input.taskID);
        return new ProcedureError(500, task.failed);
      }

      if (task.finished) {
        DeferredTasks.removeTask(input.taskID);
        // Use the getSerializedData method to ensure data is properly serialized
        return new ProcedureJSON(200, {
          data: task.getSerializedData(),
        });
      } else {
        return new ProcedureJSON(200, {
          progress: task.progress,
          logs: task.logs,
          failed: task.failed,
        });
      }
    }),
};

export default procedures;
