const express = require('express');
const app = express();
__path = process.cwd()
const bodyParser = require("body-parser");
const PORT = process.env.PORT || 8000;
let pair = require('./pair');
require('events').EventEmitter.defaultMaxListeners = 500;

app.use('/pair', pair);
app.use('/', async (req, res, next) => {
    res.sendFile(__path + '/pair.html')
})

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.listen(PORT, () => {
    console.log(`
Server running on http://localhost:` + PORT)
})

module.exports = app
