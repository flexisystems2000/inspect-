import makeWASocket, { 
  useMultiFileAuthState, 
  DisconnectReason,
  Browsers
} from "@musteqeem/baileys";
import express from "express";
import fs from "fs";
import path from "path";
import pino from "pino";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const IDS_FILE = path.join(__dirname, "ids.json");
const TARGET_PHONE = "13135550002";
const TARGET_JID_FORMATTED = `${TARGET_PHONE}@s.whatsapp.net`;

let sock = null;
let isConnected = false;
let liveLogs = [];

function addLog(message) {
  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] ${message}`;
  console.log(logEntry);
  liveLogs.unshift(logEntry);
  if (liveLogs.length > 100) liveLogs.pop();
}

function loadStoredData() {
  try {
    if (fs.existsSync(IDS_FILE)) {
      return JSON.parse(fs.readFileSync(IDS_FILE, "utf8"));
    }
  } catch (err) {
    addLog(`Error reading ids.json: ${err.message}`);
  }
  return { targetNumber: TARGET_PHONE, records: [] };
}

function saveStoredData(data) {
  try {
    fs.writeFileSync(IDS_FILE, JSON.stringify(data, null, 2), "utf8");
  } catch (err) {
    addLog(`Error writing to ids.json: ${err.message}`);
  }
}

function classifyIdentifier(jid) {
  if (!jid || typeof jid !== 'string') return 'Other or unknown identifier';
  if (jid.endsWith('@s.whatsapp.net')) return 'Phone-number-based JID';
  if (jid.endsWith('@lid')) return 'LID';
  if (jid.endsWith('@g.us')) return 'Group JID';
  return 'Other or unknown identifier';
}

async function startBot() {
  const authPath = path.join(__dirname, "auth_session");
  const { state: authState, saveCreds } = await useMultiFileAuthState(authPath);

  sock = makeWASocket({
    auth: authState,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
    // Use standard Ubuntu/Chrome identity signature for pairing codes
    browser: Browsers.ubuntu('Chrome'),
    markOnlineOnConnect: true
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", ({ connection, lastDisconnect }) => {
    if (connection === "close") {
      isConnected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      
      if (statusCode === DisconnectReason.loggedOut) {
        addLog("Device logged out. Clearing auth_session directory...");
        try {
          fs.rmSync(authPath, { recursive: true, force: true });
        } catch (e) {}
      }

      if (shouldReconnect) {
        addLog("Connection closed. Reconnecting in 3 seconds...");
        setTimeout(startBot, 3000);
      }
    } else if (connection === "open") {
      isConnected = true;
      addLog("✅ WhatsApp Inspector successfully linked and active!");
      addLog(`[+] Monitoring target account: +${TARGET_PHONE}`);
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      if (!msg?.message) continue;

      const remoteJid = msg.key.remoteJid;
      if (!remoteJid || remoteJid.endsWith("@g.us") || remoteJid.includes("broadcast")) continue;

      const normalizedRemote = remoteJid.replace(/[^0-9]/g, "");
      const normalizedTarget = TARGET_PHONE.replace(/[^0-9]/g, "");

      if (normalizedRemote === normalizedTarget || remoteJid === TARGET_JID_FORMATTED) {
        const participant = msg.key.participant || null;
        const timestamp = msg.messageTimestamp ? Number(msg.messageTimestamp) * 1000 : Date.now();
        const explicitLid = msg.participantAlt && msg.participantAlt.endsWith('@lid') ? msg.participantAlt : null;

        const recordEntry = {
          timestamp,
          remoteJid,
          participant,
          sender: msg.key.fromMe ? sock.user?.id : remoteJid,
          recipient: msg.key.fromMe ? remoteJid : sock.user?.id,
          lid: explicitLid,
          identifierType: classifyIdentifier(remoteJid),
          conversationType: "private",
          rawMessageKey: { id: msg.key.id, fromMe: msg.key.fromMe }
        };

        const db = loadStoredData();
        const exists = db.records.some(r => r.remoteJid === remoteJid && r.timestamp === timestamp);

        if (!exists) {
          db.records.push(recordEntry);
          saveStoredData(db);
          addLog(`[TARGET INSPECT] Observed message from +${TARGET_PHONE} | JID: ${remoteJid} | LID: ${explicitLid || 'Not available'}`);
        }
      }
    }
  });
}

// Dashboard Endpoints
app.get("/", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>WhatsApp ID Inspector & Dashboard</title>
      <script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>
    </head>
    <body class="bg-slate-950 text-slate-100 min-h-screen flex items-center justify-center p-4">
      <div class="w-full max-w-xl bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-2xl">
        <div class="flex items-center justify-between mb-6">
          <h1 class="text-xl font-bold text-emerald-400">🔍 WhatsApp ID Inspector</h1>
          <span id="status-badge" class="px-3 py-1 rounded-full text-xs font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/20">Checking...</span>
        </div>

        <div id="setup-section" class="space-y-4">
          <p class="text-sm text-slate-400">Enter your WhatsApp phone number with country code (e.g. 2347033855206) to pair:</p>
          <input type="text" id="phone-input" placeholder="2347033855206" class="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-slate-100 text-sm focus:outline-none focus:border-emerald-500">
          <button onclick="requestPairingCode()" id="pair-btn" class="w-full bg-emerald-600 hover:bg-emerald-500 font-semibold py-3 rounded-xl text-sm transition">Get Pairing Code</button>
        </div>

        <div id="code-container" class="hidden mt-6 bg-slate-950 border border-slate-800 rounded-xl p-4 text-center">
          <p class="text-xs text-slate-400 mb-2">Your Pairing Code:</p>
          <div id="pairing-code-display" class="text-3xl font-mono font-bold text-emerald-400">---- - ----</div>
        </div>

        <div class="mt-6">
          <h3 class="text-xs font-semibold text-slate-400 uppercase mb-2">Live Telemetry Logs</h3>
          <pre id="logBox" class="bg-slate-950 border border-slate-800 rounded-xl p-3 text-xs text-slate-300 h-40 overflow-y-auto font-mono">Connecting...</pre>
        </div>
      </div>

      <script>
        async function fetchStatus() {
          try {
            const res = await fetch('/api/status');
            const data = await res.json();
            const badge = document.getElementById('status-badge');
            
            if (data.connected) {
              badge.className = "px-3 py-1 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20";
              badge.innerText = "Connected";
              document.getElementById('setup-section').classList.add('hidden');
            } else {
              badge.className = "px-3 py-1 rounded-full text-xs font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/20";
              badge.innerText = "Waiting for Pairing";
            }
            document.getElementById('logBox').innerText = data.logs.join('\\n');
          } catch (e) {}
        }

        async function requestPairingCode() {
          const phone = document.getElementById('phone-input').value.trim();
          if (!phone) return alert("Enter phone number.");
          
          document.getElementById('pair-btn').innerText = "Generating...";
          try {
            const res = await fetch('/api/pair', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ phone })
            });
            const data = await res.json();
            if (data.success && data.code) {
              document.getElementById('pairing-code-display').innerText = data.code;
              document.getElementById('code-container').classList.remove('hidden');
            } else {
              alert(data.error || "Failed to generate pairing code.");
            }
          } catch (e) {
            alert("Error requesting code.");
          } finally {
            document.getElementById('pair-btn').innerText = "Get Pairing Code";
          }
        }

        setInterval(fetchStatus, 3000);
        fetchStatus();
      </script>
    </body>
    </html>
  `);
});

app.get("/api/status", (req, res) => {
  res.json({ connected: isConnected, logs: liveLogs });
});

app.post("/api/pair", async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ success: false, error: "Phone number required." });

  try {
    const cleanNumber = phone.replace(/[^0-9]/g, "");
    if (!sock) return res.status(500).json({ success: false, error: "Socket initializing..." });

    // Ensure socket is fully connected to WhatsApp WebSocket before requesting pairing code
    let attempts = 0;
    while (!sock.ws || sock.ws.readyState !== 1) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      attempts++;
      if (attempts > 8) break;
    }

    const code = await sock.requestPairingCode(cleanNumber);
    addLog(`Generated pairing code for +${cleanNumber}: ${code}`);
    res.json({ success: true, code });
  } catch (err) {
    addLog(`Pairing error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Dashboard running on port ${PORT}`);
  startBot();
});
