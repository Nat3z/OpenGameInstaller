import express from 'express';
import cors from 'cors';
const port = 7654;
import http from 'http';
import wsLib from 'ws';
import addonDataRoute from './api/addons';
import { AddonConnection } from './AddonConnection';

const app = express();
const server = http.createServer(app);
const wss = new wsLib.Server({ server });

const clients: Map<string, AddonConnection> = new Map();


wss.on('connection', async (ws) => {
  const connection = new AddonConnection(ws);
  const connected = await connection.setupWebsocket();
  if (!connected)
    return;

  ws.on('close', () => {
    clients.delete(connection.addonInfo.id);
  });

  clients.set(connection.addonInfo.id, connection);
});

app.all('*', (_, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Credentials", "true");
  next();
})
// allow cors for localhost:8080 and file urls
app.use(cors({
  origin: ['http://localhost:8080', 'file://']
}))



app.use(express.json());
app.use('/addons', addonDataRoute);

app.get('/', (_, res) => {
  res.send('Hello World!');
});

export { port, server, wss, clients };