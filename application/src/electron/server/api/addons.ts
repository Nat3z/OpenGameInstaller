import express from "express";
import { clients } from "../addon-server";
import { applicationAddonSecret } from "../constants";

const app = express.Router();

app.get('/', (req, res) => {
  if (req.headers.authorization !== applicationAddonSecret) {
    res.status(401).send('Unauthorized');
    return;
  }
  let info = [];
  for (const client of clients.values()) {
    info.push({ ...client.info, configTemplate: client.configTemplate });
  }

  res.json(info);
});

app.post('/:addonID/config', (req, res) => {
  if (req.headers.authorization !== applicationAddonSecret) {
    res.status(401).send('Unauthorized');
    return;
  }
  const client = clients.get(req.params.addonID);
  if (!client) {
    res.status(404).send('Client not found');
    return;
  }

  client.ws.send(JSON.stringify({ event: 'config-update', args: req.body }));
  res.send('OK');
});
export default app