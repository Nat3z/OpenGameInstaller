import express from 'express';
const port = 7654;
import http from 'http';
import wsLib from 'ws';
import { OGIAddonConfiguration, WebsocketMessageServer } from "ogi-addon";
import { ConfigurationOption } from 'ogi-addon/lib/ConfigurationBuilder';

const app = express();
const server = http.createServer(app);
const wss = new wsLib.Server({ server });
interface WebsocketInfo {
  ws: wsLib.WebSocket,
  info: OGIAddonConfiguration,
  configTemplate: unknown | ConfigurationOption
}
const clients: Map<string, WebsocketInfo> = new Map();

function updateClientInfo(websocketInfo: WebsocketInfo) {
  if (clients.get(websocketInfo.info.name)) {
    clients.set(websocketInfo.info.name, websocketInfo);
  }
  else {
    console.error("Client not found:", websocketInfo.info.name);
  }
}

wss.on('connection', (ws) => {
  console.log('Client connected, awaiting authentication...');
  let clientInfo: WebsocketInfo | undefined = undefined;

  // If the client doesn't authenticate within 1 second, kick them
  const authenticationTimeout = setTimeout(() => {
    ws.close(1008, 'Authentication timeout');
    console.error("Client kicked due to authentication timeout")
  }, 1000);

  ws.on('close', () => {
    if (clientInfo) {
      clients.delete(clientInfo.info.name);
    }
    console.error('An addon server was disconnected.')
  })

  ws.on('message', (message) => {
    const data: WebsocketMessageServer = JSON.parse(message.toString());

    switch (data.event) {
      case 'authenticate':
        clearTimeout(authenticationTimeout);

        // authentication
        clientInfo = {
          ws,
          info: data.args,
          configTemplate: undefined
        };

        clients.set(data.args.name, clientInfo);
        console.log('Client authenticated:', data.args.name);
        break;
      case 'configure':
        console.log('Client configuration received:', data.args);
        if (!clientInfo) {
          console.error('Client attempted to send config before authentication');
          ws.close(1008, 'Client attempted to send config before authentication');
          return;
        }
        clientInfo.configTemplate = data.args;
        updateClientInfo(clientInfo);
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