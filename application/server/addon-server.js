const express = require('express');
const port = 7654;
const http = require('http');
const { Server } = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new Server({ server });

wss.on('connection', (ws) => {
  console.log('Client connected');
  ws.on('message', (message) => {
    console.log(`Received message => ${message}`);
  });
  ws.on('close', () => {
    console.log('Client disconnected');
  });
});

app.get('/', (req, res) => {
  res.send('Hello World!');
});

module.exports = { app, port, server, wss };