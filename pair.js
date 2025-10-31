const zlib = require('zlib');
const express = require('express');
const fs = require('fs');
let router = express.Router();
const pino = require("pino");
const { default: makeWASocket, useMultiFileAuthState, delay, Browsers, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');

// makeid function included directly
function makeid(num = 4) {
  let result = "";
  let characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  var characters9 = characters.length;
  for (var i = 0; i < num; i++) {
    result += characters.charAt(Math.floor(Math.random() * characters9));
  }
  return result;
}

function removeFile(FilePath) {
    if (!fs.existsSync(FilePath)) return false;
    fs.rmSync(FilePath, { recursive: true, force: true });
}

// Mega session handler
async function handleMegaSession(sock, id) {
    try {
        const { upload } = require('./mega');
        let rf = __dirname + `/temp/${id}/creds.json`;
        const mega_url = await upload(fs.createReadStream(rf), `${sock.user.id}.json`);
        const string_session = mega_url.replace('https://mega.nz/file/', '');
        return "IK~" + string_session;
    } catch (e) {
        throw new Error(`Mega upload failed: ${e.toString()}`);
    }
}

// Base64 session handler
async function handleBase64Session(sock, id) {
    try {
        let data = fs.readFileSync(__dirname + `/temp/${id}/creds.json`);
        let compressedData = zlib.gzipSync(data);
        let b64data = compressedData.toString('base64');
        return "Ali~" + b64data;
    } catch (e) {
        throw new Error(`Base64 encoding failed: ${e.toString()}`);
    }
}

// Common connection handler
async function handleConnection(sock, id, sessionType) {
    await delay(5000);
    
    let sessionData;
    try {
        if (sessionType === 'mega') {
            sessionData = await handleMegaSession(sock, id);
        } else {
            sessionData = await handleBase64Session(sock, id);
        }
        
        // Send session ID
        let codeMsg = await sock.sendMessage(sock.user.id, { text: sessionData });
        
        // Send welcome message for KHAN-MD
        await sock.sendMessage(
            sock.user.id,
            {
                text: `╭─〔 *KHAN-MD SESSION ID 👾* 〕\n│  \n├ 🧩 *This Session ID is Unique & Confidential!*  \n├ ❌ *Never share it with anyone, not even friends.*  \n├ ⚙️ *Use only for deploying your KHAN-MD Bot.*\n│  \n├ 🤖 *Welcome to the future of automation with KHAN-MD!*  \n│  \n╰─✅ *You're now part of the KHAN-MD Network!*  \n\n━━━━━━━━━━━━━━━━━━━━━━\n\n╭──〔 🔗 *BOT RESOURCES* 〕\n│  \n├ 💎 *KHAN-MD GitHub Repo:*  \n│   https://github.com/JawadYT36/KHAN-MD\n│  \n╰─🚀 *Powered by JawadTechX 🤍*`
            },
            { quoted: codeMsg }
        );
        
    } catch (e) {
        let errorMsg = await sock.sendMessage(sock.user.id, { text: e.toString() });
        let desc = `*Don't Share with anyone this code use for deploying KHAN-MD*\n\n ◦ *Github:* https://github.com/JawadYT36/KHAN-MD`;
        await sock.sendMessage(sock.user.id, { text: desc }, { quoted: errorMsg });
    }
    
    await delay(10);
    await sock.ws.close();
    await removeFile('./temp/' + id);
    console.log(`👤 ${sock.user.id} Connected ✅ Restarting process...`);
    await delay(10);
    process.exit();
}

// Main pairing function - FIXED VERSION
async function KHAN_MD_PAIR_CODE(num, res, sessionType) {
    const id = makeid();
    let sock = null;
    let isConnected = false;
    
    const { state, saveCreds } = await useMultiFileAuthState('./temp/' + id);
    
    try {
        sock = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }).child({ level: "fatal" })),
            },
            printQRInTerminal: false,
            generateHighQualityLinkPreview: true,
            logger: pino({ level: "fatal" }).child({ level: "fatal" }),
            syncFullHistory: false,
            browser: Browsers.ubuntu('Chrome'),
            connectTimeoutMs: 60000,
            keepAliveIntervalMs: 10000,
            markOnlineOnConnect: true,
            emitOwnEvents: true,
            defaultQueryTimeoutMs: 0,
            transactionOpts: {
                maxRetries: 3,
                delayBetweenTriesMs: 1000
            }
        });
        
        sock.ev.on('creds.update', saveCreds);
        
        sock.ev.on("connection.update", async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            console.log('Connection update:', connection);
            
            if (qr) {
                console.log('QR received');
            }
            
            if (connection === "open") {
                console.log('Connection opened successfully');
                isConnected = true;
                await handleConnection(sock, id, sessionType);
            } 
            else if (connection === "close") {
                console.log('Connection closed');
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const error = lastDisconnect?.error;
                
                console.log('Disconnect status:', statusCode);
                console.log('Disconnect error:', error);
                
                // Don't reconnect if it's intentional (401) or already connected
                if (statusCode !== 401 && !isConnected) {
                    console.log('Attempting to reconnect...');
                    await delay(2000);
                    await removeFile('./temp/' + id);
                    return await KHAN_MD_PAIR_CODE(num, res, sessionType);
                }
            }
            else if (connection === "connecting") {
                console.log('Connecting to WhatsApp...');
            }
        });

        // Request pairing code after socket setup
        if (!sock.authState.creds.registered) {
            await delay(2000);
            num = num.replace(/[^0-9]/g, '');
            
            try {
                const code = await sock.requestPairingCode(num);
                console.log('Pairing code requested:', code);
                
                if (!res.headersSent) {
                    await res.send({ 
                        code: code,
                        status: "success",
                        message: "Pairing code generated successfully"
                    });
                }
            } catch (pairError) {
                console.error('Pairing code error:', pairError);
                if (!res.headersSent) {
                    await res.send({ 
                        code: "ERROR", 
                        status: "error",
                        message: "Failed to generate pairing code: " + pairError.message
                    });
                }
                await removeFile('./temp/' + id);
            }
        }

    } catch (err) {
        console.log("Service error:", err);
        await removeFile('./temp/' + id);
        if (!res.headersSent) {
            await res.send({ 
                code: "ERROR", 
                status: "error",
                message: "Service unavailable: " + err.message
            });
        }
    }
}

// Routes
router.get('/mega', async (req, res) => {
    let num = req.query.number;
    if (!num) {
        return res.status(400).send({ error: "Number parameter is required" });
    }
    return await KHAN_MD_PAIR_CODE(num, res, 'mega');
});

router.get('/base64', async (req, res) => {
    let num = req.query.number;
    if (!num) {
        return res.status(400).send({ error: "Number parameter is required" });
    }
    return await KHAN_MD_PAIR_CODE(num, res, 'base64');
});

module.exports = router;
