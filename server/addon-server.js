const express = require('express');
const app = express();
const port = 7654;

app.get('/', (req, res) => {
  res.send('Hello World!');
});

module.exports = { app, port };