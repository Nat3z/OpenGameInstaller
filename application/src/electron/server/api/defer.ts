import { clients } from "../addon-server.js";
import { applicationAddonSecret } from "../constants.js";
import { DeferrableTask } from "../DeferrableTask.js";
import express from "express";

const app = express.Router();
export const DefferedTasks = new Map<string, DeferrableTask<any>>();

// Get all deferred tasks
app.get('/', (req, res) => {
  if (req.headers.authorization !== applicationAddonSecret) {
    res.status(401).send('Unauthorized');
    return;
  }

  const tasks = Array.from(DefferedTasks.values()).map(task => ({
    id: task.id,
    addonOwner: task.addonOwner,
    finished: task.finished,
    progress: task.progress,
    logs: task.logs,
    failureMessage: task.failureMessage
  }));

  res.json(tasks);
});

app.get('/:taskID', (req, res) => {
  if (req.headers.authorization !== applicationAddonSecret) {
    res.status(401).send('Unauthorized');
    return;
  }

  if (!DefferedTasks.has(req.params.taskID)) {
    res.status(404).send('Task not found');
    return;
  }

  const task = DefferedTasks.get(req.params.taskID)!!;

  // check if the addon is still running
  const stillExists = clients.has(task.addonOwner);
  if (!stillExists) {
    res.status(410).send('Addon is no longer connected');
    DefferedTasks.delete(req.params.taskID);
    return;
  }
  if (task.finished) {
    res.send(task.data);
    DefferedTasks.delete(req.params.taskID);
  }

  else {
    res.status(202).send({ progress: task.progress, logs: task.logs });
  }
});

export default app