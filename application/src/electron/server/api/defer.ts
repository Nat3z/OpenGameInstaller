import { z } from 'zod';
import { clients } from '../addon-server.js';
import { applicationAddonSecret } from '../constants.js';
import { DeferrableTask } from '../DeferrableTask.js';
import {
  procedure,
  Procedure,
  ProcedureError,
  ProcedureJSON,
} from '../serve.js';

export const DefferedTasks = new Map<string, DeferrableTask<any>>();

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
      const tasks: ResponseDeferredTask[] = Array.from(
        DefferedTasks.values()
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

      return new ProcedureJSON(tasks);
    }),

  // Get specific task by ID
  getTask: procedure()
    .input(
      z.object({
        taskID: z.string(),
      })
    )
    .handler(async (input) => {
      if (!DefferedTasks.has(input.taskID)) {
        return new ProcedureError(404, 'Task not found');
      }

      const task = DefferedTasks.get(input.taskID)!!;

      // check if the addon is still running
      const stillExists = clients.has(task.addonOwner);
      if (!stillExists) {
        DefferedTasks.delete(input.taskID);
        return new ProcedureError(410, 'Addon is no longer connected');
      }

      if (task.failed) {
        DefferedTasks.delete(input.taskID);
        return new ProcedureError(500, task.failed);
      }

      if (task.finished) {
        DefferedTasks.delete(input.taskID);
        return new ProcedureJSON(task.data);
      } else {
        return new ProcedureJSON({
          progress: task.progress,
          logs: task.logs,
          failed: task.failed,
        });
      }
    }),
};

export default procedures;
