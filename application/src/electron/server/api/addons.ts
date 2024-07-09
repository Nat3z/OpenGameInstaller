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
  const response = await client.sendEventMessage({ event: 'configure', args: req.body });
  if (response.args.success)
    res.json({ success: true });
  else {
    res.json({ success: false, error: response.args.error, keyErrored: response.args.keyErrored })
  }
});
export default app