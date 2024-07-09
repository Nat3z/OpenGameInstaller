import express from "express";
import { clients } from "../addon-server";
import { applicationAddonSecret } from "../constants";
import { DeferrableTask } from "../DeferrableTask";
import { DefferedTasks } from "./defer";

const app = express.Router();

app.get('/', (req, res) => {
  if (req.headers.authorization !== applicationAddonSecret) {
    res.status(401).send('Unauthorized');
    return;
  }
  let info = [];
  for (const client of clients.values()) {
    info.push({ ...client.addonInfo, configTemplate: client.configTemplate });
  }

  res.json(info);
});

app.post('/:addonID/config', async (req, res) => {
  if (req.headers.authorization !== applicationAddonSecret) {
    res.status(401).send('Unauthorized');
    return;
  }
  const client = clients.get(req.params.addonID);
  if (!client) {
    res.status(404).send('Client not found');
    return;
  }
  const response = await client.sendEventMessage({ event: 'config-update', args: req.body });
  if (response.args.success)
    res.json({ success: true });
  else {
    res.json({ success: false, error: response.args.error, keyErrored: response.args.keyErrored })
  }
});
// an expensive task.
app.get('/:addonID/search', async (req, res) => {
  if (req.headers.authorization !== applicationAddonSecret) {
    return res.status(401).send('Unauthorized');
  }
  if (!req.query.query) {
    return res.status(400).send('No query provided');
  }
  const client = clients.get(req.params.addonID);
  if (!client)
    return res.status(404).send('Client not found');

  const deferrableTask = new DeferrableTask(async () => {
    const event = await client.sendEventMessage({ event: 'search', args: req.query.query })
    return event.args;
  });
  deferrableTask.run();
  DefferedTasks.set(deferrableTask.id, deferrableTask);
  return res.status(202).json({ deferred: true, taskID: deferrableTask.id });
});
export default app