// pair.js
const zlib = require('zlib');
const express = require('express');
const fs = require('fs');
const path = require('path');
let router = express.Router();
const pino = require('pino');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  delay,
  Browsers,
  makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');

const BASE_TEMP = path.join(__dirname, 'temp');
if (!fs.existsSync(BASE_TEMP)) fs.mkdirSync(BASE_TEMP, { recursive: true });

// ----------------- helpers -----------------
function makeid(len = 8) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < len; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}

function removeRecursiveSafe(p) {
  try {
    if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
  } catch (e) {
    console.warn('[cleanup] failed', e?.message || e);
  }
}

// Normalize user number, add Pakistan prefix if looks local
function normalizeNumber(raw) {
  if (!raw) return '';
  let n = String(raw).trim();
  n = n.replace(/\s+/g, '');
  if (n.startsWith('+')) n = n.slice(1);
  // if user provides 10 digits starting with 3 or 0 (03xxxx or 3xxxx)
  if (/^0[3][0-9]{9}$/.test(n)) { // 03xxxxxxxxx -> 923xxxxxxxxx
    return '92' + n.slice(1);
  }
  if (/^[3][0-9]{9}$/.test(n)) { // 3xxxxxxxxx -> 923xxxxxxxxx
    return '92' + n;
  }
  // if already has country code (e.g., 923xxxxxxxxx) return as is
  if (/^[1-9][0-9]{7,14}$/.test(n)) return n;
  return n; // best-effort
}

// gzip+base64 wrapper for creds.json
function encodeGzipBase64(filePath) {
  const data = fs.readFileSync(filePath);
  const compressed = zlib.gzipSync(data);
  return compressed.toString('base64');
}

// optional mega uploader wrapper (if you implement ./mega.upload)
async function uploadToMegaIfExists(filePath, sockUserId) {
  try {
    const megaMod = require('./mega'); // must export upload(stream, name)
    if (!megaMod || typeof megaMod.upload !== 'function') throw new Error('mega.upload not found');
    const stream = fs.createReadStream(filePath);
    const url = await megaMod.upload(stream, `${sockUserId}.json`);
    return url;
  } catch (e) {
    throw e;
  }
}

// ----------------- main logic -----------------
async function sendSessionToUser(sock, sessionPath, sessionMode) {
  const credsFile = path.join(sessionPath, 'creds.json');
  if (!fs.existsSync(credsFile)) throw new Error('creds.json not found');

  if (sessionMode === 'mega') {
    const url = await uploadToMegaIfExists(credsFile, sock.user.id);
    // return a compact mega-based id
    return 'IK~' + url.replace('https://mega.nz/file/', '');
  }

  // default: gzip + base64 with ALI-MD≈ prefix (many tools expect this)
  const b64 = encodeGzipBase64(credsFile);
  return 'ALI-MD≈' + b64;
}

// safe/deduped connection handler
async function handleConnectionAndSend(sock, sessionPath, sessionMode) {
  // wait a little for creds to flush
  await delay(2500);

  const sessionId = await sendSessionToUser(sock, sessionPath, sessionMode);

  // send main session text
  const codeMsg = await sock.sendMessage(sock.user.id, { text: sessionId });

  // friendly message quoted
  await sock.sendMessage(
    sock.user.id,
    {
      text:
        '╭─〔 *SESSION ID READY* 〕\n' +
        '├ This is your confidential session id.\n' +
        '├ Never share it with anyone.\n' +
        '╰─ Use to deploy your bot.',
    },
    { quoted: codeMsg }
  );
}

// route worker (creates socket per session)
async function makePair(numRaw, res, sessionMode = 'base64') {
  const id = makeid(10);
  const sessionPath = path.join(BASE_TEMP, id);
  if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

  // prepare auth state store
  let state, saveCreds;
  try {
    ({ state, saveCreds } = await useMultiFileAuthState(sessionPath));
  } catch (e) {
    removeRecursiveSafe(sessionPath);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to init auth state', detail: e.message });
    return;
  }

  // choose random browser descriptor
  const browsers = [
    Browsers.macOS('Safari'),
    Browsers.macOS('Chrome'),
    Browsers.macOS('Opera'),
    Browsers.windows('Edge'),
    Browsers.windows('Firefox'),
    Browsers.ubuntu('Brave'),
    Browsers.iphone('Safari'),
    Browsers.android('Chrome'),
  ];
  const browser = browsers[Math.floor(Math.random() * browsers.length)];

  // create socket
  let sock;
  try {
    sock = makeWASocket({
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' })) },
      printQRInTerminal: false,
      logger: pino({ level: 'fatal' }),
      browser,
      syncFullHistory: false,
      generateHighQualityLinkPreview: true,
      connectTimeoutMs: 60_000,
      keepAliveIntervalMs: 30_000,
    });
  } catch (e) {
    removeRecursiveSafe(sessionPath);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to create socket', detail: e.message });
    return;
  }

  // persist creds updates
  sock.ev.on('creds.update', saveCreds);

  // debounce connection updates so we don't spam logs/responses
  let lastConnAt = 0;
  let alreadySentPairingResponse = false;
  let done = false;

  sock.ev.on('connection.update', async (update) => {
    try {
      const now = Date.now();
      if (now - lastConnAt < 2500) {
        // ignore very frequent duplicate events
      } else {
        lastConnAt = now;
        console.log('[pair] connection.update ->', update?.connection || update);
      }

      const { connection, lastDisconnect } = update;

      if (connection === 'open' && !done) {
        done = true;
        try {
          await delay(1200); // small wait for creds.json to be written
          await handleConnectionAndSend(sock, sessionPath, sessionMode);
        } catch (e) {
          console.error('[pair] handleConnectionAndSend error', e);
          try {
            await sock.sendMessage(sock.user.id, { text: 'Error generating session: ' + e.message });
          } catch {}
        } finally {
          // close websocket gracefully, but do NOT process.exit()
          try { if (sock?.ws) await sock.ws.close(); } catch (ee) {}
          removeRecursiveSafe(sessionPath);
          console.log('[pair] finished for', id);
        }
      }

      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        console.log('[pair] closed:', code);
        // don't retry on auth errors (401) or if we already provided session
        if (code !== 401 && !done) {
          // small backoff then cleanup and try again (once)
          await delay(2000);
          removeRecursiveSafe(sessionPath);
          // avoid infinite loops: we won't call makePair recursively more than once here.
        } else {
          removeRecursiveSafe(sessionPath);
        }
      }
    } catch (e) {
      console.error('[pair] connection.update handler failed', e);
    }
  });

  // request pairing code if not already registered
  try {
    await delay(900);
    const normalized = normalizeNumber(String(numRaw || ''));
    if (!normalized) {
      removeRecursiveSafe(sessionPath);
      if (!res.headersSent) return res.status(400).json({ error: 'Invalid number' });
      return;
    }
    // request pairing code
    try {
      const code = await sock.requestPairingCode(normalized);
      if (!res.headersSent) {
        res.json({ code: code, status: 'ok' });
      }
    } catch (pairErr) {
      console.error('[pair] requestPairingCode failed', pairErr?.message || pairErr);
      removeRecursiveSafe(sessionPath);
      if (!res.headersSent) res.status(500).json({ error: 'Failed to generate pairing code', detail: pairErr?.message });
    }
  } catch (e) {
    console.error('[pair] outer error', e);
    removeRecursiveSafe(sessionPath);
    if (!res.headersSent) res.status(500).json({ error: 'Unexpected error', detail: e.message });
  }
}

// ----------------- routes -----------------
router.get('/base64', async (req, res) => {
  const num = req.query.number;
  return makePair(num, res, 'base64');
});

router.get('/mega', async (req, res) => {
  const num = req.query.number;
  return makePair(num, res, 'mega');
});

module.exports = router;
