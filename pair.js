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
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: num }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
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

// Base64 Session Generator
async function handleBase64Session(sock, id) {
  try {
    const rf = path.join(BASE_TEMP, id, 'creds.json');
    if (!fs.existsSync(rf)) throw new Error('creds.json not found to encode');
    const data = fs.readFileSync(rf);
    const compressed = zlib.gzipSync(data);
    return "ALI-MD≈" + compressed.toString('base64');
  } catch (e) {
    throw new Error(`Base64 encoding failed: ${e.toString()}`);
  }
}

// Connection Success Handler
async function handleConnection(sock, id, sessionType) {
  await delay(2000);
  try {
    const session = await handleBase64Session(sock, id);
    const msg = await sock.sendMessage(sock.user.id, { text: session });
    await sock.sendMessage(sock.user.id, {
      text: "✅ *SESSION ID READY*\nKeep it safe — never share!\nUse this ID to deploy your bot.",
    }, { quoted: msg });
  } catch (e) {
    console.error("handleConnection error:", e);
    try { await sock.sendMessage(sock.user.id, { text: `Error: ${String(e)}` }); } catch {}
  } finally {
    try { await sock.ws.close(); } catch {}
    removeFile(path.join(BASE_TEMP, id));
  }
}

// MAIN FUNCTION
async function KHAN_MD_PAIR_CODE(num, res, sessionType) {
  const id = makeid(8);
  const sessionPath = path.join(BASE_TEMP, id);
  if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

  try {
    if (!num) return res.status(400).json({ error: "Missing number" });
    const cleanNum = num.replace(/[^0-9]/g, '');
    if (!/^92\d{9,10}$/.test(cleanNum))
      return res.status(400).json({ error: "Invalid number format. Use 923001234567" });

    const browsers = [
      Browsers.macOS("Safari"),
      Browsers.windows("Edge"),
      Browsers.ubuntu("Chrome"),
      Browsers.android("Chrome")
    ];
    const browser = browsers[Math.floor(Math.random() * browsers.length)];

    const sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
      },
      printQRInTerminal: false,
      logger: pino({ level: "silent" }),
      browser,
      syncFullHistory: false,
      generateHighQualityLinkPreview: true
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect } = update;
      if (connection === "open") {
        await handleConnection(sock, id, sessionType);
      } else if (connection === "close") {
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== 401;
        console.log('connection closed', shouldReconnect ? '→ retrying' : '→ not retrying');
        removeFile(sessionPath);
      }
    });

    await delay(1000);
    let code;
    try {
      code = await sock.requestPairingCode(cleanNum);
      console.log("✅ PAIR CODE:", code);
    } catch (err) {
      console.error("❌ Error getting pairing code:", err);
      if (!res.headersSent) return res.status(500).json({ error: "Failed to generate pairing code", details: err.message });
      return;
    }

    if (!res.headersSent) res.json({ number: cleanNum, code });

  } catch (err) {
    console.error("KHAN_MD_PAIR_CODE error:", err);
    if (!res.headersSent) res.status(500).json({ error: "Service Unavailable", details: err.message });
    removeFile(sessionPath);
  }
}

// ROUTES
router.get('/base64', async (req, res) => {
  const num = req.query.number;
  return KHAN_MD_PAIR_CODE(num, res, 'base64');
});

router.get('/mega', async (req, res) => {
  const num = req.query.number;
  return KHAN_MD_PAIR_CODE(num, res, 'mega');
});

module.exports = router;
