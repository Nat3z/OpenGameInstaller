import express from 'express';
const port = 7654;
import http from 'http';
import wsLib from 'ws';
import { OGIAddonConfiguration, WebsocketMessageServer } from "ogi-addon";

const app = express();
const server = http.createServer(app);
const wss = new wsLib.Server({ server });

const clients: Map<string, {
  ws: wsLib.WebSocket,
  config: OGIAddonConfiguration
}> = new Map();

wss.on('connection', (ws) => {
  console.log('Client connected, awaiting authentication...');
  const authenticationTimeout = setTimeout(() => {
    ws.close(1008, 'Authentication timeout');
    console.error("Client kicked due to authentication timeout")
  }, 1000);
  ws.on('message', (message) => {
    const data: WebsocketMessageServer = JSON.parse(message.toString());
    switch (data.event) {
      case 'authenticate':
        clearTimeout(authenticationTimeout);
        const config: OGIAddonConfiguration = data.args;
        clients.set(config.name, { ws, config });
        console.log('Client authenticated:', config.name);
        break; 
    }
  });
  ws.on('close', () => {
    console.log('Client disconnected');
  });
});

app.get('/', (req, res) => {
  res.send('Hello World!');
});
export { app, port, server, wss, clients };