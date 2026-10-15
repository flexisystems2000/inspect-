import makeWASocket, { 
  useMultiFileAuthState, 
  DisconnectReason
} from "@musteqeem/baileys";
import express from "express";
import fs from "fs";
import path from "path";
import pino from "pino";
import { fileURLToPath } from "url";

// Define __dirname in ES module scope
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const IDS_FILE = path.join(__dirname, "ids.json");
const TARGET_PHONE = "13135550002";
const TARGET_JID_FORMATTED = `${TARGET_PHONE}@s.whatsapp.net`;

// Global runtime variables
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

// Persistent Storage Helpers for ID Inspection
function loadStoredData() {
  try {
    if (fs.existsSync(IDS_FILE)) {
      const raw = fs.readFileSync(IDS_FILE, "utf8");
      return JSON.parse(raw);
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

// --- Web Dashboard UI ---
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
          <h1 class="text-xl font-bold tracking-wide text-emerald-400">🔍 WhatsApp ID Inspector</h1>
          <span id="status-badge" class="px-3 py-1 rounded-full text-xs font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/20">
            Checking...
          </span>
        </div>

        <div class="mb-6 bg-slate-950 border border-slate-800 rounded-xl p-4">
          <p class="text-xs text-slate-400 mb-1">Target Account Monitored:</p>
          <p class="text-sm font-semibold text-emerald-400">+${TARGET_PHONE} (Private chats only)</p>
        </div>

        <div id="setup-section" class="space-y-4">
          <p class="text-sm text-slate-400">Enter your WhatsApp phone number with country code (e.g. <span class="text-slate-200">2348123456789</span>) to generate your pairing code.</p>
          <div>
            <label class="block text-xs font-medium text-slate-400 mb-1">Phone Number</label>
            <input type="text" id="phone-input" placeholder="2348123456789" class="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-slate-100 focus:outline-none focus:border-emerald-500 text-sm">
          </div>
          <button onclick="requestPairingCode()" id="pair-btn" class="w-full bg-emerald-600 hover:bg-emerald-500 font-semibold py-3 rounded-xl transition duration-200 text-sm shadow-lg shadow-emerald-900/30 cursor-pointer">
            Get Pairing Code
          </button>
        </div>

        <div id="code-container" class="hidden mt-6 bg-slate-950 border border-slate-800 rounded-xl p-4 text-center">
          <p class="text-xs text-slate-400 mb-2">Your 8-Digit Pairing Code:</p>
          <div id="pairing-code-display" class="text-3xl font-mono font-bold tracking-widest text-emerald-400 select-all">
            ---- - ----
          </div>
          <p class="text-xs text-slate-500 mt-2">Go to WhatsApp &gt; Linked Devices &gt; Link with phone number instead</p>
        </div>

        <div id="connected-banner" class="hidden mt-6 bg-emerald-950/40 border border-emerald-800/50 rounded-xl p-4 text-center">
          <p class="text-emerald-400 font-semibold text-sm">✅ Bot is active, connected, and inspecting targets!</p>
        </div>

        <div class="mt-6">
          <h3 class="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Live Telemetry Logs</h3>
          <pre id="logBox" class="bg-slate-950 border border-slate-800 rounded-xl p-3 text-xs text-slate-300 h-40 overflow-y-auto font-mono">Connecting to log stream...</pre>
        </div>
      </div>

      <script>
        async function fetchStatus() {
          try {
            const res = await fetch('/api/status');
            const data = await res.json();
            const badge = document.getElementById('status-badge');
            const setupSec = document.getElementById('setup-section');
            const connectedBanner = document.getElementById('connected-banner');

            if (data.connected) {
              badge.className = "px-3 py-1 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20";
              badge.innerText = "Connected";
              setupSec.classList.add('hidden');
              connectedBanner.classList.remove('hidden');
            } else {
              badge.className = "px-3 py-1 rounded-full text-xs font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/20";
              badge.innerText = "Waiting for Pairing";
            }

            document.getElementById('logBox').innerText = data.logs.join('\\n');
          } catch (e) {}
        }

        async function requestPairingCode() {
          const phone = document.getElementById('phone-input').value.trim();
          const btn = document.getElementById('pair-btn');
          if (!phone) {
            alert("Please enter a valid phone number.");
            return;
          }

          btn.innerText = "Generating...";
          btn.disabled = true;

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
            alert("Network error occurred.");
          } finally {
            btn.innerText = "Get Pairing Code";
            btn.disabled = false;
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
  if (!phone) {
    return res.status(400).json({ success: false, error: "Phone number is required." });
  }

  if (isConnected) {
    return res.json({ success: false, error: "Bot is already connected." });
  }

  try {
    const cleanNumber = phone.replace(/[^0-9]/g, "");
    if (!sock) {
      return res.status(500).json({ success: false, error: "Bot socket not ready yet. Please wait a few seconds and try again." });
    }

    let attempts = 0;
    while (!sock.ws || sock.ws.readyState !== 1) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      attempts++;
      if (attempts > 5) break;
    }

    const code = await sock.requestPairingCode(cleanNumber);
    addLog(`Generated pairing code for +${cleanNumber}: ${code}`);
    res.json({ success: true, code });
  } catch (err) {
    addLog(`Pairing code error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message || "Failed to get pairing code." });
  }
});

// --- Baileys Bot Logic ---
async function startBot() {
  const { state: authState, saveCreds } = await useMultiFileAuthState(path.join(__dirname, "auth_session"));

  sock = makeWASocket({
    auth: authState,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
    browser: ["Chrome (Linux)", "", ""]
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", ({ connection, lastDisconnect }) => {
    if (connection === "close") {
      isConnected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      
      if (statusCode === DisconnectReason.loggedOut) {
        addLog("Device logged out. Clearing session for re-pairing...");
        try {
          fs.rmSync(path.join(__dirname, "auth_session"), { recursive: true, force: true });
        } catch (e) {}
      }

      if (shouldReconnect) {
        addLog("Connection closed. Reconnecting in 5 seconds...");
        setTimeout(startBot, 5000);
      }
    } else if (connection === "open") {
      isConnected = true;
      addLog("✅ WhatsApp ID Inspector Bot successfully connected and persistent!");
      addLog(`[+] Monitoring target account: +${TARGET_PHONE} in private chats.`);
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      if (!msg?.message) continue;

      const remoteJid = msg.key.remoteJid;
      if (!remoteJid) continue;

      if (remoteJid.endsWith("@g.us") || remoteJid.includes("broadcast")) continue;

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
          addLog(`[TARGET INSPECT] Observed message from +${TARGET_PHONE} | JID: ${remoteJid} | Type: ${recordEntry.identifierType} | LID: ${explicitLid || 'Not available'}`);
        }

        if (msg.key.fromMe && msg.message?.conversation) {
          const text = msg.message.conversation.trim();

          if (text === '!target') {
            await sock.sendMessage(remoteJid, { text: `Configured Target Number: +${TARGET_PHONE}` });
          } else if (text === '!inspect') {
            const currentDb = loadStoredData();
            const targetRecords = currentDb.records.filter(r => r.remoteJid.includes(TARGET_PHONE));
            if (targetRecords.length === 0) {
              await sock.sendMessage(remoteJid, { 
                text: `Target +${TARGET_PHONE} has not sent an observed message yet. LID not available in the observed message metadata. The supplied phone number alone is insufficient to derive the LID.` 
              });
            } else {
              const latest = targetRecords[targetRecords.length - 1];
              const report = `Target Inspection Report:\n- JID: ${latest.remoteJid}\n- Type: ${latest.identifierType}\n- LID: ${latest.lid || 'Unavailable'}\n- Last Seen: ${new Date(latest.timestamp).toISOString()}`;
              await sock.sendMessage(remoteJid, { text: report });
            }
          } else if (text === '!total') {
            const currentDb = loadStoredData();
            const uniqueIds = new Set(currentDb.records.map(r => r.remoteJid));
            await sock.sendMessage(remoteJid, { text: `Total unique identifiers recorded: ${uniqueIds.size}` });
          } else if (text === '!exportids') {
            await sock.sendMessage(remoteJid, { text: `Export complete. Identifiers are safely saved locally in ids.json.` });
          }
        }
      }
    }
  });
}

// Start Express Server & Bot Socket
app.listen(PORT, () => {
  console.log(`🚀 Web Dashboard running on port ${PORT}`);
  startBot();
});
