const zlib = require('zlib');
const express = require('express');
const fs = require('fs');
const path = require('path');
let router = express.Router();
const pino = require("pino");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  delay,
  Browsers,
  makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');

// helper: random id
function makeid(num = 8) {
  let result = "";
  const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < num; i++) result += characters.charAt(Math.floor(Math.random() * characters.length));
  return result;
}

// ensure temp base exists
const BASE_TEMP = path.join(__dirname, 'temp');
if (!fs.existsSync(BASE_TEMP)) fs.mkdirSync(BASE_TEMP, { recursive: true });

function removeFile(FilePath) {
  try {
    if (fs.existsSync(FilePath)) fs.rmSync(FilePath, { recursive: true, force: true });
  } catch (e) {
    console.warn('Cleanup failed:', e?.message || e);
  }
}

// Mega session handler (optional - implement ./mega.upload)
async function handleMegaSession(sock, id) {
  try {
    const mega = require('./mega'); // your module should export upload(stream, name)
    const rf = path.join(BASE_TEMP, id, 'creds.json');
    if (!fs.existsSync(rf)) throw new Error('creds.json not found for mega upload');
    const mega_url = await mega.upload(fs.createReadStream(rf), `${sock.user.id}.json`);
    const string_session = mega_url.replace('https://mega.nz/file/', '');
    return "IK~" + string_session;
  } catch (e) {
    throw new Error(`Mega upload failed: ${e.toString()}`);
  }
}

// Base64+gzip session handler
async function handleBase64Session(sock, id) {
  try {
    const rf = path.join(BASE_TEMP, id, 'creds.json');
    if (!fs.existsSync(rf)) throw new Error('creds.json not found to encode');
    const data = fs.readFileSync(rf);
    const compressedData = zlib.gzipSync(data);
    const b64data = compressedData.toString('base64');
    return "ALI-MD≈" + b64data; // consistent with many tools
  } catch (e) {
    throw new Error(`Base64 encoding failed: ${e.toString()}`);
  }
}

async function handleConnection(sock, id, sessionType) {
  await delay(3000);

  let sessionData;
  try {
    if (sessionType === 'mega') sessionData = await handleMegaSession(sock, id);
    else sessionData = await handleBase64Session(sock, id);

    // send session text
    const codeMsg = await sock.sendMessage(sock.user.id, { text: sessionData });

    // short friendly message quoted
    await sock.sendMessage(
      sock.user.id,
      {
        text: `╭─〔 *SESSION ID READY* 〕\n├ This is your confidential session id.\n├ Never share it.\n╰─ Use to deploy your bot.`,
      },
      { quoted: codeMsg }
    );
  } catch (e) {
    console.error('handleConnection error:', e);
    try {
      await sock.sendMessage(sock.user.id, { text: `Error generating session: ${String(e)}` });
    } catch (sendErr) {
      console.error('failed to send error to user:', sendErr);
    }
  } finally {
    try { await delay(500); } catch {}
    try { if (sock.ws) await sock.ws.close(); } catch (ee) {}
    removeFile(path.join(BASE_TEMP, id));
    console.log(`Cleanup done for ${id}`);
  }
}

async function KHAN_MD_PAIR_CODE(num, res, sessionType) {
  const id = makeid(8);
  const sessionPath = path.join(BASE_TEMP, id);
  if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

  try {
    // choose random browser descriptor
    const randomBrowsers = [
      Browsers.macOS("Safari"),
      Browsers.macOS("Chrome"),
      Browsers.macOS("Opera"),
      Browsers.windows("Edge"),
      Browsers.windows("Firefox"),
      Browsers.ubuntu("Brave"),
      Browsers.iphone("Safari"),
      Browsers.android("Chrome")
    ];
    const browser = randomBrowsers[Math.floor(Math.random() * randomBrowsers.length)];

    const sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" })),
      },
      printQRInTerminal: false,
      generateHighQualityLinkPreview: true,
      logger: pino({ level: "fatal" }),
      syncFullHistory: false,
      browser
    });

    // prevent message spam listeners from default code (optional)
    try { sock.ev.removeAllListeners('messages.upsert'); } catch (e) {}

    // save creds as they update
    sock.ev.on('creds.update', saveCreds);

    // pairing code request
    if (!sock.authState?.creds?.registered) {
      await delay(1200);
      if (!num || typeof num !== 'string') {
        if (!res.headersSent) res.status(400).send({ error: 'missing number' });
        try { await sock.ws.close(); } catch {}
        removeFile(sessionPath);
        return;
      }
      const cleanNum = num.replace(/[^0-9]/g, '');
      try {
        const code = await sock.requestPairingCode(cleanNum);
        if (!res.headersSent) res.json({ code });
      } catch (err) {
        console.error('requestPairingCode failed:', err?.message || err);
        if (!res.headersSent) res.status(500).json({ error: 'failed to request pairing code' });
        try { await sock.ws.close(); } catch {}
        removeFile(sessionPath);
        return;
      }
    }

    // connection update handling
    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect } = update;
      console.log('connection update', connection);
      if (connection === "open") {
        // wait for creds.json to be written
        let tries = 0;
        const maxTries = 12;
        while (tries < maxTries) {
          const credsFile = path.join(sessionPath, 'creds.json');
          if (fs.existsSync(credsFile)) break;
          tries++;
          await delay(1000);
        }
        await handleConnection(sock, id, sessionType);
      } else if (connection === "close") {
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== 401;
        console.log('connection closed', shouldReconnect ? '→ will retry' : '→ not retrying (401)');
        removeFile(sessionPath);
        if (shouldReconnect) setTimeout(() => KHAN_MD_PAIR_CODE(num, res, sessionType), 3000);
      }
    });

  } catch (err) {
    console.error('KHAN_MD_PAIR_CODE error:', err);
    removeFile(sessionPath);
    if (!res.headersSent) res.status(500).json({ code: "Service Unavailable" });
  }
}

// Routes
router.get('/mega', async (req, res) => {
  const num = req.query.number;
  return KHAN_MD_PAIR_CODE(num, res, 'mega');
});

router.get('/base64', async (req, res) => {
  const num = req.query.number;
  return KHAN_MD_PAIR_CODE(num, res, 'base64');
});

module.exports = router;
