const express = require('express');
const app = express();
const bodyParser = require("body-parser");
const path = require('path');
require('events').EventEmitter.defaultMaxListeners = 500;

const PORT = process.env.PORT || 8000;
const pair = require('./pair');

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Pairing routes
app.use('/pair', pair);

// Simple UI if you want (pair.html placed in root)
app.use('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'pair.html'));
});

app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});

module.exports = app;
