import { applicationAddonSecret } from "../constants";
import { DeferrableTask } from "../DeferrableTask";
import express from "express";

const app = express.Router();
export const DefferedTasks = new Map<string, DeferrableTask<any>>();

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
  if (task.finished) {
    res.json(task.data);
    DefferedTasks.delete(req.params.taskID);
  }

  else {
    res.status(202).send("TASK_NOT_READY");
  }
});

export default app