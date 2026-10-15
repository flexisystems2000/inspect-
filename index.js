const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    isJidGroup,
    isJidBroadcast
} = require('@musteqeem/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const express = require('express');
const fs = require('fs');
const path = require('path');

const TARGET_PHONE = '13135550002';
const TARGET_JID_FORMATTED = `${TARGET_PHONE}@bot`;
const IDS_FILE = path.join(__dirname, 'ids.json');
const PORT = 3000;

// App State
let sock = null;
let connectionStatus = 'disconnected';
let currentPairingCode = null;
let liveLogs = [];
let isConnecting = false;

function addLog(message) {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] ${message}`;
    console.log(logEntry);
    liveLogs.unshift(logEntry);
    if (liveLogs.length > 100) liveLogs.pop(); // Keep max 100 logs
}

function loadStoredData() {
    try {
        if (fs.existsSync(IDS_FILE)) {
            const raw = fs.readFileSync(IDS_FILE, 'utf8');
            return JSON.parse(raw);
        }
    } catch (err) {
        addLog(`Error reading ids.json: ${err.message}`);
    }
    return { targetNumber: TARGET_PHONE, targetJidFormat: TARGET_JID_FORMATTED, records: [] };
}

function saveStoredData(data) {
    try {
        fs.writeFileSync(IDS_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
        addLog(`Error writing to ids.json: ${err.message}`);
    }
}

function classifyIdentifier(jid) {
    if (!jid || typeof jid !== 'string') return 'Other or unknown identifier';
    if (jid.endsWith('@bot')) return 'Meta AI system layer tag (@bot)';
    if (jid.endsWith('@s.whatsapp.net')) return 'Phone-number-based JID';
    if (jid.endsWith('@lid')) return 'LID configuration';
    if (jid.endsWith('@g.us')) return 'Group JID endpoint';
    return 'Other or unknown identifier';
}

async function startBot() {
    if (isConnecting) return;
    isConnecting = true;

    try {
        const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
        
        sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            browser: ['Chrome (Linux)', '', '']
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect } = update;
            
            if (connection) {
                connectionStatus = connection;
                addLog(`Connection state: ${connection}`);
            }

            if (connection === 'close') {
                isConnecting = false;
                const statusCode = (lastDisconnect?.error instanceof Boom)?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                
                if (statusCode === DisconnectReason.loggedOut) {
                    addLog('Device logged out. Please clear auth session and re-pair.');
                } else if (shouldReconnect) {
                    addLog('Connection lost. Reestablishing persistent connection in 5 seconds...');
                    setTimeout(startBot, 5000);
                } else {
                    addLog('Connection closed permanently.');
                }
            } else if (connection === 'open') {
                isConnecting = false;
                addLog('WhatsApp session successfully connected and persistent!');
                currentPairingCode = null;
            }
        });

        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;

            for (const msg of messages) {
                const remoteJid = msg.key.remoteJid;
                if (!remoteJid) continue;

                // Command Intercept: .addai meta [group_jid]
                if (msg.key.fromMe && msg.message?.conversation) {
                    const text = msg.message.conversation.trim();
                    if (text.startsWith('.addai')) {
                        const parts = text.split(' ');
                        if (parts.length >= 3 && parts[1].toLowerCase() === 'meta') {
                            const targetGroupId = parts[2].trim();
                            try {
                                addLog(`Executing protocol injection: Adding ${TARGET_JID_FORMATTED} to group ${targetGroupId}`);
                                await sock.groupParticipantsUpdate(targetGroupId, [TARGET_JID_FORMATTED], 'add');
                                await sock.sendMessage(remoteJid, { text: `[SUCCESS] Injection update dispatched for ${TARGET_JID_FORMATTED}` });
                            } catch (err) {
                                addLog(`Protocol error on .addai: ${err.message}`);
                                await sock.sendMessage(remoteJid, { text: `[ERROR] Failed: ${err.message}` });
                            }
                        } else {
                            await sock.sendMessage(remoteJid, { text: 'Format: .addai meta [group_jid]' });
                        }
                        continue;
                    }
                }

                if (isJidGroup(remoteJid) || isJidBroadcast(remoteJid)) continue;

                if (remoteJid === TARGET_JID_FORMATTED || remoteJid.includes(TARGET_PHONE)) {
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
                        conversationType: 'private',
                        rawMessageKey: { id: msg.key.id, fromMe: msg.key.fromMe }
                    };

                    const db = loadStoredData();
                    const exists = db.records.some(r => r.remoteJid === remoteJid && r.timestamp === timestamp);
                    
                    if (!exists) {
                        db.records.push(recordEntry);
                        saveStoredData(db);
                        addLog(`[TARGET INTERCEPT] Observed message from ${remoteJid} | Type: ${recordEntry.identifierType}`);
                    }
                }
            }
        });
    } catch (err) {
        isConnecting = false;
        addLog(`Socket initialization error: ${err.message}`);
        setTimeout(startBot, 5000);
    }
}

// Express Web Dashboard
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>WhatsApp Persistent Bot Dashboard</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; margin: 0; padding: 20px; }
        .container { max-width: 900px; margin: 0 auto; background: #1e293b; padding: 24px; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.4); border: 1px solid #334155; }
        h1 { font-size: 1.6rem; margin-top: 0; color: #38bdf8; display: flex; align-items: center; justify-content: space-between; }
        .card { background: #0f172a; padding: 18px; border-radius: 8px; margin-bottom: 18px; border: 1px solid #334155; }
        pre { background: #090d16; padding: 14px; border-radius: 6px; overflow-x: auto; font-size: 0.82rem; color: #cbd5e1; max-height: 280px; margin: 0; }
        .badge { display: inline-block; padding: 4px 10px; border-radius: 4px; font-size: 0.8rem; font-weight: bold; }
        .badge.open { background: #166534; color: #bbf7d0; }
        .badge.connecting { background: #854d0e; color: #fef08a; }
        .badge.close, .badge.disconnected { background: #991b1b; color: #fecaca; }
        input, button { padding: 10px 14px; font-size: 1rem; border-radius: 6px; border: 1px solid #475569; }
        input { background: #1e293b; color: #fff; width: 65%; margin-right: 8px; }
        button { background: #0284c7; color: #fff; border: none; cursor: pointer; font-weight: bold; }
        button:hover { background: #0ea5e9; }
        .code-display { font-size: 1.8rem; font-weight: bold; color: #4ade80; letter-spacing: 2px; margin-top: 12px; }
    </style>
</head>
<body>
    <div class="container">
        <h1>
            <span>WhatsApp Persistent Bot Dashboard</span>
            <span id="statusBadge" class="badge disconnected">Loading...</span>
        </h1>
        
        <div class="card">
            <h3>Generate Pairing Code</h3>
            <p style="color: #94a3b8; font-size: 0.9rem;">Enter your WhatsApp phone number with country code (e.g., 15551234567, without +):</p>
            <input type="text" id="phoneInput" placeholder="15551234567" />
            <button onclick="requestPairingCode()">Request Code</button>
            <div id="codeResult" class="code-display"></div>
        </div>

        <div class="card">
            <h3>Live Telemetry Logs</h3>
            <pre id="logBox">Connecting to log stream...</pre>
        </div>
    </div>
    
    <script>
        async function fetchStatus() {
            try {
                const res = await fetch('/api/status');
                const data = await res.json();
                
                const badge = document.getElementById('statusBadge');
                badge.innerText = data.connectionStatus.toUpperCase();
                badge.className = 'badge ' + data.connectionStatus;
                
                if (data.currentPairingCode) {
                    document.getElementById('codeResult').innerText = data.currentPairingCode;
                }
                
                document.getElementById('logBox').innerText = data.liveLogs.join('\\n');
            } catch (e) {
                console.error('Polling error:', e);
            }
        }

        async function requestPairingCode() {
            const phone = document.getElementById('phoneInput').value.trim();
            if (!phone) { alert('Enter your phone number.'); return; }
            try {
                const res = await fetch('/api/pair', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ phone })
                });
                const data = await res.json();
                if (data.success) {
                    document.getElementById('codeResult').innerText = data.code;
                } else {
                    alert('Error: ' + data.error);
                }
            } catch (e) {
                alert('Request failed: ' + e.message);
            }
        }
        
        setInterval(fetchStatus, 2000);
        fetchStatus();
    </script>
</body>
</html>`);
});

app.get('/api/status', (req, res) => {
    res.json({ connectionStatus, currentPairingCode, liveLogs });
});

app.post('/api/pair', async (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ success: false, error: 'Phone number required' });
    try {
        if (!sock) return res.status(500).json({ success: false, error: 'Socket initializing...' });
        if (sock.authState.creds.registered) return res.json({ success: false, error: 'Already registered!' });
        
        const code = await sock.requestPairingCode(phone.replace(/[^0-9]/g, ''));
        currentPairingCode = code;
        addLog(`Generated pairing code for +${phone}: ${code}`);
        res.json({ success: true, code });
    } catch (err) {
        addLog(`Pairing failed: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`[+] Persistent server running at http://localhost:${PORT}`);
    startBot();
});
