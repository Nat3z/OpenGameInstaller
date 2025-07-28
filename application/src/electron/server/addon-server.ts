import express from 'express';
import cors from 'cors';
const port = 7654;
import http from 'http';
import { WebSocketServer } from 'ws';
import addonProcedures from './api/addons.js';
import deferProcedures from './api/defer.js';
import { AddonConnection } from './AddonConnection.js';
import { AddonServer } from './serve.js';
import { sendIPCMessage } from '../main.js';
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const clients: Map<string, AddonConnection> = new Map();

wss.on('connection', async (ws) => {
  const connection = new AddonConnection(ws);
  const connected = await connection.setupWebsocket();
  if (!connected) return;

  ws.on('close', () => {
    console.log('Client disconnected', connection.addonInfo.id);
    clients.delete(connection.addonInfo.id);
  });

  clients.set(connection.addonInfo.id, connection);
  await sendIPCMessage('addon-connected', connection.addonInfo.id);
});

app.all('*', (_, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Credentials', 'true');
  next();
});
// allow cors for localhost:8080 and file urls
app.use(
  cors({
    origin: ['http://localhost:8080', 'file://'],
  })
);

app.use(express.json());

app.get('/', (_, res) => {
  res.send('Hello World!');
});

const addonServer = new AddonServer({
  ...addonProcedures,
  ...deferProcedures,
});

export { port, server, wss, clients, addonServer };
