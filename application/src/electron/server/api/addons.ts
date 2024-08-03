import express from "express";
import { clients } from "../addon-server.js";
import { applicationAddonSecret } from "../constants.js";
import { DeferrableTask } from "../DeferrableTask.js";
import { DefferedTasks } from "./defer.js";

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
    res.json({ success: false, errors: response.args.error })
  }
});
// an expensive task.
app.get('/:addonID/search', async (req, res) => {
  if (req.headers.authorization !== applicationAddonSecret) {
    return res.status(401).send('Unauthorized');
  }
 
  if (!req.query.steamappid || !req.query.gameID) {
    return res.status(400).send('No query provided');
  } 

  const client = clients.get(req.params.addonID);
  if (!client)
    return res.status(404).send('Client not found');


  const deferrableTask = new DeferrableTask(async () => {
    const event = await client.sendEventMessage({ event: 'search', args: { text: req.query.gameID ?? req.query.steamappid, type: req.query.gameID ? 'internal' : req.query.steamappid ? 'steamapp' : '' } });
    return event.args;
  }, client.addonInfo.id);
  deferrableTask.run();
  DefferedTasks.set(deferrableTask.id, deferrableTask);
  return res.status(202).json({ deferred: true, taskID: deferrableTask.id });
});
app.post('/:addonID/search-query', async (req, res) => {
  if (req.headers.authorization !== applicationAddonSecret) {
    return res.status(401).send('Unauthorized');
  }
  if (!req.body || req.body.query === undefined || typeof req.body.query !== 'string') {
    return res.status(400).send('No query provided');
  }
  const client = clients.get(req.params.addonID);
  if (!client)
    return res.status(404).send('Client not found');

  const deferrableTask = new DeferrableTask(async () => {
    const event = await client.sendEventMessage({ event: 'library-search', args: req.body.query });
    return event.args;
  }, client.addonInfo.id);
  deferrableTask.run();
  DefferedTasks.set(deferrableTask.id, deferrableTask);
  return res.status(202).json({ deferred: true, taskID: deferrableTask.id });
});

app.post('/:addonID/setup-app', async (req, res) => {
  if (req.headers.authorization !== applicationAddonSecret) {
    return res.status(401).send('Unauthorized');
  }
  const client = clients.get(req.params.addonID);
  if (!client)
    return res.status(404).send('Client not found');
  if (!req.body || req.body.path === undefined || typeof req.body.path !== 'string') {
    return res.status(400).send('No path provided');
  }
  if (!req.body || req.body.type === undefined || typeof req.body.type !== 'string') {
    return res.status(400).send('No type provided');
  }
  if (!req.body || req.body.name === undefined || typeof req.body.name !== 'string') {
    return res.status(400).send('No name provided');
  }
  if (req.body.steamAppID === undefined) {
    return res.status(400).send('No steamAppID provided');
  }
  if (!req.body || req.body.usedRealDebrid === undefined || typeof req.body.usedRealDebrid !== 'boolean') {
    return res.status(400).send('No usedRealDebrid provided');
  }

  const deferrableTask = new DeferrableTask(async () => {
    const data = await client.sendEventMessage({ event: 'setup', args: { path: req.body.path, steamAppID: req.body.steamAppID, type: req.body.type, usedRealDebrid: req.body.usedRealDebrid, name: req.body.name, multiFiles: req.body.multiPartFiles, deferID: deferrableTask.id!! } });
    return data.args;
  }, client.addonInfo.id);

  deferrableTask.run();
  DefferedTasks.set(deferrableTask.id, deferrableTask);
  return res.status(202).json({ deferred: true, taskID: deferrableTask.id });
});

app.post('/:addonID/game-details', async (req, res) => {
  if (req.headers.authorization !== applicationAddonSecret) {
    return res.status(401).send('Unauthorized');
  }
  const client = clients.get(req.params.addonID);
  if (!client)
    return res.status(404).send('Client not found');
  if (!req.body || req.body.gameID === undefined) {
    return res.status(400).send('No steamAppID provided');
  }

  const deferrableTask = new DeferrableTask(async () => {
    const data = await client.sendEventMessage({ event: 'game-details', args: req.body.gameID });
    return data.args;
  }, client.addonInfo.id);

  deferrableTask.run();
  DefferedTasks.set(deferrableTask.id, deferrableTask);
  return res.status(202).json({ deferred: true, taskID: deferrableTask.id });
});
export default app