import express from "express";
import { clients } from "../addon-server";
import { applicationAddonSecret } from '../constants';

const app = express.Router();

app.get('/', (req, res) => {
  if (req.query.secret !== applicationAddonSecret) {
    res.status(401).send('Unauthorized');
    return;
  }

  let info = [];
  for (const client of clients.values()) {
    info.push({ ...client.info, configTemplate: client.configTemplate });
  }

  res.json(info);
});

export default app