const zlib = require('zlib');
const express = require('express');
const fs = require('fs');
let router = express.Router();
const pino = require("pino");
const { default: makeWASocket, useMultiFileAuthState, delay, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');

// Random ID generator
function makeid(num = 4) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return [...Array(num)].map(() => chars[Math.floor(Math.random() * chars.length)]).join('');
}

// Remove temp folder safely
function removeFile(path) {
  if (fs.existsSync(path)) fs.rmSync(path, { recursive: true, force: true });
}

// Upload to Mega.nz
async function handleMegaSession(sock, id) {
  try {
    const { upload } = require('./mega');
    const file = __dirname + `/temp/${id}/creds.json`;
    const mega_url = await upload(fs.createReadStream(file), `${sock.user.id}.json`);
    const string_session = mega_url.replace('https://mega.nz/file/', '');
    return "IK~" + string_session;
  } catch (e) {
    throw new Error(`Mega upload failed: ${e}`);
  }
}

// Encode to Base64
async function handleBase64Session(sock, id) {
  try {
    const data = fs.readFileSync(__dirname + `/temp/${id}/creds.json`);
    const compressed = zlib.gzipSync(data);
    return "Ali~" + compressed.toString('base64');
  } catch (e) {
    throw new Error(`Base64 encoding failed: ${e}`);
  }
}

// Connection handler
async function handleConnection(sock, id, type) {
  try {
    await delay(3000);
    const session = type === 'mega'
      ? await handleMegaSession(sock, id)
      : await handleBase64Session(sock, id);

    const codeMsg = await sock.sendMessage(sock.user.id, { text: session });

    await sock.sendMessage(sock.user.id, {
      text: `╭─〔 *KHAN-MD SESSION ID 👾* 〕
│  
├ 🧩 *This Session ID is Unique & Confidential!*  
├ ❌ *Never share it with anyone.*  
├ ⚙️ *Use only for deploying KHAN-MD Bot.*
│  
├ 🤖 *Welcome to the future of automation with KHAN-MD!*  
│  
╰─✅ *You're now part of the KHAN-MD Network!*  

━━━━━━━━━━━━━━━━━━━━━━

╭──〔 🔗 *BOT RESOURCES* 〕
│  
├ 💎 *GitHub Repo:*  
│   https://github.com/JawadYT36/KHAN-MD
│  
╰─🚀 *Powered by JawadTechX 🤍*`
    }, { quoted: codeMsg });

    console.log(`✅ ${sock.user.id} session generated successfully.`);
  } catch (e) {
    console.error("Session error:", e);
    await sock.sendMessage(sock.user.id, { text: e.toString() });
  } finally {
    await delay(1000);
    await sock.ws.close();
    removeFile('./temp/' + id);
  }
}

// Main pairing
async function KHAN_MD_PAIR_CODE(num, res, sessionType) {
  const id = makeid();
  const { state, saveCreds } = await useMultiFileAuthState('./temp/' + id);

  try {
    const sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
      },
      printQRInTerminal: false,
      generateHighQualityLinkPreview: true,
      logger: pino({ level: "silent" }),
      syncFullHistory: false,
      browser: ["Ubuntu", "Chrome", "20.0.04"]
    });

    if (!sock.authState.creds.registered) {
      await delay(2000);
      num = num.replace(/[^0-9]/g, '');
      if (!num.startsWith("92")) num = "92" + num; // Default Pakistan code
      try {
        const code = await sock.requestPairingCode(num);
        if (!res.headersSent) return res.send({ code });
      } catch (err) {
        console.error("Pairing failed:", err);
        if (!res.headersSent) return res.send({ code: "⚠️ Error generating code. Try again later." });
      }
    }

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on("connection.update", async (s) => {
      const { connection } = s;
      if (connection === "open") await handleConnection(sock, id, sessionType);
    });

  } catch (err) {
    console.error("Service error:", err);
    removeFile('./temp/' + id);
    if (!res.headersSent) res.send({ code: "❗ Service Unavailable" });
  }
}

// Routes
router.get('/mega', async (req, res) => {
  const num = req.query.number;
  return await KHAN_MD_PAIR_CODE(num, res, 'mega');
});

router.get('/base64', async (req, res) => {
  const num = req.query.number;
  return await KHAN_MD_PAIR_CODE(num, res, 'base64');
});

module.exports = router;
