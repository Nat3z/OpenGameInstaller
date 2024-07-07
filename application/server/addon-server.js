const express = require('express');
const port = 7654;
const http = require('http');
const { Server, } = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new Server({ server });

/**
 * @type {Map<String, WebSocket>}
 * @description A map of all connected clients, with their respective WebSocket instances.
 */
const clients = new Map();

wss.on('connection', (ws) => {
  console.log('Client connected, awaiting authentication...');
  
  ws.on('message', (message) => {
    /**
     * @type {import("ogi-addon/main").WebsocketMessage}
     */
    const data = JSON.parse(message);
    switch (data.event) {
      case 'authenticate':
        /**
         * @type {import("ogi-addon/main").OGIAddonConfiguration}
         */
        const config = data.args;
    }
  });
  ws.on('close', () => {
    console.log('Client disconnected');
  });
});

app.get('/', (req, res) => {
  res.send('Hello World!');
});

module.exports = { app, port, server, wss };