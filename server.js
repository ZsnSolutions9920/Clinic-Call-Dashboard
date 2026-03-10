require('dotenv').config();
const express = require('express');
const session = require('express-session');
const http = require('http');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const archiver = require('archiver');
const SqliteStore = require('better-sqlite3-session-store')(require('express-session'));
// OpenAI removed — using Google Gemini instead

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const DOCTOR_PHONE = process.env.DOCTOR_PHONE;
const CLINICEA_BASE_URL = process.env.CLINICEA_BASE_URL || 'https://app.clinicea.com/clinic.aspx';
const SESSION_SECRET = process.env.SESSION_SECRET;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

const GROQ_API_KEY = process.env.GROQ_API_KEY;

if (!SESSION_SECRET) {
  console.error('ERROR: SESSION_SECRET is not set in .env');
  process.exit(1);
}

// Trust Nginx proxy (needed for secure cookies behind reverse proxy)
app.set('trust proxy', 1);

// --- Hardcoded Login Credentials ---
const USERS = {
  admin: { password: 'clinicea2025', role: 'admin' },
  agent1: { password: 'password1', role: 'agent' },
  agent2: { password: 'password2', role: 'agent' },
  agent3: { password: 'password3', role: 'agent' },
  agent4: { password: 'password4', role: 'agent' },
  agent5: { password: 'password5', role: 'agent' },
};

// Clinicea API configuration
const CLINICEA_API_KEY = process.env.CLINICEA_API_KEY;
const CLINICEA_STAFF_USERNAME = process.env.CLINICEA_STAFF_USERNAME;
const CLINICEA_STAFF_PASSWORD = process.env.CLINICEA_STAFF_PASSWORD;
const CLINICEA_API_BASE = 'https://api.clinicea.com';

// --- SQLite Setup ---
const db = new Database('calls.db');
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    caller_number TEXT NOT NULL,
    call_sid TEXT,
    clinicea_url TEXT,
    patient_name TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Add patient_name and patient_id columns if missing (existing DBs)
try { db.exec('ALTER TABLE calls ADD COLUMN patient_name TEXT'); } catch (e) { /* already exists */ }
try { db.exec('ALTER TABLE calls ADD COLUMN patient_id TEXT'); } catch (e) { /* already exists */ }
try { db.exec('ALTER TABLE calls ADD COLUMN agent TEXT'); } catch (e) { /* already exists */ }

// One-time migration: normalize all existing 03XXX numbers to +92XXX
const oldNumbers = db.prepare("SELECT id, caller_number FROM calls WHERE caller_number LIKE '03%' AND length(caller_number) = 11").all();
if (oldNumbers.length > 0) {
  const updateNum = db.prepare('UPDATE calls SET caller_number = ? WHERE id = ?');
  const migrate = db.transaction(() => {
    for (const row of oldNumbers) {
      updateNum.run('+92' + row.caller_number.substring(1), row.id);
    }
  });
  migrate();
  console.log(`[MIGRATION] Normalized ${oldNumbers.length} phone numbers from 03XXX to +92XXX`);
}

const updateCallPatientName = db.prepare(
  'UPDATE calls SET patient_name = ? WHERE id = ?'
);
const updateCallPatientId = db.prepare(
  'UPDATE calls SET patient_id = ? WHERE id = ?'
);
const PAGE_SIZE = 10;

// --- Server Event Log (pushed to dashboard) ---
const eventLog = []; // last 50 events kept in memory
const MAX_LOG = 50;

function logEvent(type, message, details) {
  const entry = { type, message, details: details || null, time: new Date().toISOString() };
  eventLog.push(entry);
  if (eventLog.length > MAX_LOG) eventLog.shift();
  io.emit('server_log', entry);
  // Also log to console
  const prefix = type === 'error' ? '[ERROR]' : type === 'warn' ? '[WARN]' : '[INFO]';
  console.log(`${prefix} ${message}${details ? ' | ' + details : ''}`);
}

// --- Middleware ---
// CORS for Chrome extension
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && (origin.includes('web.whatsapp.com') || origin.includes('chrome-extension'))) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.urlencoded({ extended: false })); // Twilio sends form-encoded
app.use(express.json());
// Persistent session store — sessions survive server restarts and deployments
const sessionDb = new Database('sessions.db');
const sessionMiddleware = session({
  store: new SqliteStore({
    client: sessionDb,
    expired: {
      clear: true,           // Auto-delete expired sessions
      intervalMs: 900000     // Clean up every 15 minutes
    }
  }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 } // 7 days (sessions persist across restarts now)
});
app.use(sessionMiddleware);

// --- Auth ---
function requireAuth(req, res, next) {
  if (req.session && req.session.loggedIn) return next();
  if (req.headers.accept && req.headers.accept.includes('application/json')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return res.redirect('/login');
}

// Login page
app.get('/login', (req, res) => {
  const error = req.query.error ? '<p style="color:#e74c3c;margin-bottom:16px;">Invalid username or password</p>' : '';
  res.send(`<!DOCTYPE html>
<html lang="en"><head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>Login - Clinic Call Dashboard</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f0f2f5;display:flex;align-items:center;justify-content:center;min-height:100vh}
    .login-box{background:#fff;padding:40px;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,0.1);width:100%;max-width:380px}
    .login-box h1{font-size:22px;color:#1a1a2e;margin-bottom:24px;text-align:center}
    label{display:block;font-size:14px;font-weight:600;color:#333;margin-bottom:6px}
    input{width:100%;padding:10px 14px;border:1px solid #dee2e6;border-radius:6px;font-size:15px;margin-bottom:16px}
    input:focus{outline:none;border-color:#1a1a2e;box-shadow:0 0 0 2px rgba(26,26,46,0.15)}
    button{width:100%;padding:12px;background:#1a1a2e;color:#fff;border:none;border-radius:6px;font-size:15px;font-weight:600;cursor:pointer}
    button:hover{background:#2d2d5e}
  </style>
</head><body>
  <div class="login-box">
    <h1>Clinic Call Dashboard</h1>
    ${error}
    <form method="POST" action="/login">
      <label for="username">Username</label>
      <input type="text" id="username" name="username" required autofocus>
      <label for="password">Password</label>
      <input type="password" id="password" name="password" required>
      <button type="submit">Sign In</button>
    </form>
  </div>
</body></html>`);
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  const user = USERS[username];
  if (user && user.password === password) {
    req.session.loggedIn = true;
    req.session.username = username;
    req.session.role = user.role;
    return res.redirect('/');
  }
  return res.redirect('/login?error=1');
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ username: req.session.username, role: req.session.role });
});

// Debug endpoint: show connected sockets and their rooms (admin only)
app.get('/api/socket-debug', requireAuth, (req, res) => {
  if (req.session.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const rooms = {};
  for (const [roomName, socketIds] of io.sockets.adapter.rooms) {
    // Skip per-socket rooms (socket IDs match room names)
    if (io.sockets.sockets.has(roomName)) continue;
    rooms[roomName] = Array.from(socketIds);
  }
  const sockets = [];
  for (const [id, socket] of io.sockets.sockets) {
    const sess = socket.request.session;
    sockets.push({
      id,
      username: sess && sess.username || null,
      role: sess && sess.role || null,
      rooms: Array.from(socket.rooms).filter(r => r !== id)
    });
  }
  res.json({ totalSockets: io.sockets.sockets.size, rooms, sockets });
});

// Webhook auth middleware
function requireWebhookSecret(req, res, next) {
  if (!WEBHOOK_SECRET) return next();
  const provided = req.headers['x-webhook-secret'] || req.body.secret;
  if (provided !== WEBHOOK_SECRET) {
    logEvent('error', 'Webhook auth failed — invalid secret', 'IP: ' + (req.ip || req.connection.remoteAddress));
    return res.status(401).json({ error: 'Invalid webhook secret' });
  }
  next();
}

// Normalize Pakistani phone numbers to +92 format
function normalizePKPhone(phone) {
  const clean = phone.replace(/[\s\-\(\)]/g, '');
  if (clean.startsWith('03') && clean.length === 11) return '+92' + clean.substring(1);
  if (clean.startsWith('92') && !clean.startsWith('+') && clean.length === 12) return '+' + clean;
  return clean;
}

// Call webhook - secured with WEBHOOK_SECRET
app.post('/incoming_call', requireWebhookSecret, (req, res) => {
  const rawCaller = req.body.From || 'Unknown';
  const caller = rawCaller !== 'Unknown' ? normalizePKPhone(rawCaller) : rawCaller;
  const callSid = req.body.CallSid || '';
  const rawAgent = (req.body.Agent || '').trim();

  logEvent('info', `POST /incoming_call received`, `From: "${rawCaller}" | Agent: "${rawAgent}" | IP: ${req.ip || req.connection.remoteAddress}`);

  // Validate agent — must be a known username, never broadcast blindly
  const agent = (rawAgent && USERS[rawAgent]) ? rawAgent : null;

  // Build Clinicea patient lookup URL
  const cliniceaUrl = `${CLINICEA_BASE_URL}?tp=pat&m=${encodeURIComponent(caller)}`;

  // Log to database with agent
  const result = db.prepare(
    'INSERT INTO calls (caller_number, call_sid, clinicea_url, agent) VALUES (?, ?, ?, ?)'
  ).run(caller, callSid, cliniceaUrl, agent);
  const callId = result.lastInsertRowid;

  const callEvent = {
    caller,
    callSid,
    cliniceaUrl,
    callId,
    agent: agent || null,
    timestamp: new Date().toISOString()
  };

  // Route call event to the correct dashboards
  if (agent) {
    const agentRoom = io.sockets.adapter.rooms.get('agent:' + agent);
    const adminRoom = io.sockets.adapter.rooms.get('role:admin');
    const agentCount = agentRoom ? agentRoom.size : 0;
    const adminCount = adminRoom ? adminRoom.size : 0;
    // Known agent — send to that agent + admin only
    io.to('agent:' + agent).emit('incoming_call', callEvent);
    io.to('role:admin').emit('incoming_call', callEvent);
    logEvent('info', 'Incoming call: ' + caller, `Agent: ${agent} | SID: ${callSid} | URL: ${cliniceaUrl} | Sockets: agent:${agent}=${agentCount}, role:admin=${adminCount}`);
  } else {
    const totalSockets = io.sockets.sockets.size;
    // No agent tag — broadcast to all dashboards so the call isn't missed
    io.emit('incoming_call', callEvent);
    logEvent('info', 'Incoming call (no agent): ' + caller, `SID: ${callSid} | URL: ${cliniceaUrl} | Broadcast to ALL (${totalSockets} sockets)`);
  }

  // Async: look up patient name and push update to dashboard
  if (isClinicaConfigured()) {
    findPatientByPhone(caller).then(patient => {
      if (patient) {
        if (patient.patientName) {
          updateCallPatientName.run(patient.patientName, callId);
        }
        if (patient.patientID) {
          updateCallPatientId.run(patient.patientID, callId);
        }
        const patientEvent = { caller, callId, agent: agent || null, patientName: patient.patientName, patientID: patient.patientID };
        // Same routing as incoming_call
        if (agent) {
          io.to('agent:' + agent).emit('patient_info', patientEvent);
          io.to('role:admin').emit('patient_info', patientEvent);
        } else {
          io.emit('patient_info', patientEvent);
        }
        logEvent('info', 'Patient identified: ' + (patient.patientName || 'Unknown'), caller);
      }
    }).catch(() => {});
  }

  // Respond with OK
  res.json({ status: 'ok', caller, cliniceaUrl });
});

// --- Test Call (simulate incoming call from dashboard) ---
app.post('/api/test-call', requireAuth, (req, res) => {
  const caller = req.body.phone || '+920000000000';
  const agent = req.session.username;
  const cliniceaUrl = `${CLINICEA_BASE_URL}?tp=pat&m=${encodeURIComponent(caller)}`;
  const callSid = 'test-' + Date.now();

  const result = db.prepare(
    'INSERT INTO calls (caller_number, call_sid, clinicea_url, agent) VALUES (?, ?, ?, ?)'
  ).run(caller, callSid, cliniceaUrl, agent);
  const callId = result.lastInsertRowid;

  const callEvent = { caller, callSid, cliniceaUrl, callId, agent, timestamp: new Date().toISOString() };

  io.to('agent:' + agent).emit('incoming_call', callEvent);
  if (req.session.role === 'admin') {
    io.to('role:admin').emit('incoming_call', callEvent);
  }
  logEvent('info', `TEST CALL triggered by ${agent}: ${caller}`, `URL: ${cliniceaUrl}`);
  res.json({ status: 'ok', callEvent });
});

// --- Monitor log upload (so we can read logs remotely) ---
const monitorLogs = {}; // { agent: "log text" }
app.post('/api/monitor-log', requireWebhookSecret, (req, res) => {
  const agent = (req.body.Agent || '_default').trim();
  const logText = req.body.Log || '';
  monitorLogs[agent] = logText;
  res.json({ status: 'ok' });
});
app.get('/api/monitor-log/:agent', requireAuth, (req, res) => {
  const agent = req.params.agent || '_default';
  res.type('text/plain').send(monitorLogs[agent] || '(no log uploaded yet)');
});
app.get('/api/monitor-log', requireAuth, (req, res) => {
  res.json(Object.keys(monitorLogs).map(k => ({ agent: k, lines: (monitorLogs[k] || '').split('\n').length })));
});

// --- Monitor Heartbeat (per-agent, strict isolation) ---
const agentHeartbeats = {}; // { agent: { lastHeartbeat, alive } }
const warnedBadAgents = new Set(); // only warn once per unknown agent value
const HEARTBEAT_STALE_MS = 90000; // 90s — generous to survive server restarts + network hiccups
const HEARTBEAT_CHECK_INTERVAL = 15000; // check every 15s
const serverStartTime = Date.now();
// Grace period after server start — don't mark monitors dead until they've had time to send a heartbeat
const STARTUP_GRACE_MS = 120000; // 2 min grace after server restart

app.post('/heartbeat', requireWebhookSecret, (req, res) => {
  const start = Date.now();
  const rawAgent = (req.body.Agent || '').trim();
  const agent = (rawAgent && USERS[rawAgent]) ? rawAgent : null;
  const key = agent || '_default';
  const prev = agentHeartbeats[key] || { lastHeartbeat: 0, alive: false };
  const wasDown = !prev.alive;
  const now = Date.now();
  agentHeartbeats[key] = { lastHeartbeat: now, alive: true };
  if (agent) {
    io.to('agent:' + agent).emit('monitor_status', { alive: true, agent });
    io.to('role:admin').emit('monitor_status', { alive: true, agent });
    if (wasDown) logEvent('info', `Call monitor connected: ${agent}`, `IP: ${req.ip || req.connection.remoteAddress}`);
  } else {
    io.emit('monitor_status', { alive: true, agent: null });
    if (wasDown) logEvent('info', `Call monitor connected (no agent tag, raw: "${rawAgent}")`, `IP: ${req.ip || req.connection.remoteAddress}`);
  }
  const elapsed = Date.now() - start;
  if (elapsed > 500) {
    logEvent('warn', `Heartbeat slow: ${elapsed}ms`, `agent: ${key}`);
  }
  res.json({ status: 'ok' });
});

// Check every 15s if any agent monitor went stale
setInterval(() => {
  const now = Date.now();
  // During startup grace period, don't mark anything dead
  if ((now - serverStartTime) < STARTUP_GRACE_MS) return;

  for (const [key, state] of Object.entries(agentHeartbeats)) {
    if (state.alive && (now - state.lastHeartbeat) > HEARTBEAT_STALE_MS) {
      const staleSec = Math.round((now - state.lastHeartbeat) / 1000);
      state.alive = false;
      if (key !== '_default' && USERS[key]) {
        io.to('agent:' + key).emit('monitor_status', { alive: false, agent: key });
        io.to('role:admin').emit('monitor_status', { alive: false, agent: key });
        logEvent('warn', `Call monitor disconnected: ${key}`, `No heartbeat for ${staleSec}s`);
      } else {
        io.emit('monitor_status', { alive: false, agent: null });
        logEvent('warn', 'Call monitor disconnected (untagged)', `No heartbeat for ${staleSec}s`);
      }
    }
  }
}, HEARTBEAT_CHECK_INTERVAL);

app.get('/api/monitor-status', requireAuth, (req, res) => {
  const agent = req.session.username;
  const isAdmin = req.session.role === 'admin';
  const now = Date.now();
  // During startup grace, report status as "unknown" rather than "dead"
  const inGrace = (now - serverStartTime) < STARTUP_GRACE_MS;

  if (isAdmin) {
    const anyAlive = Object.values(agentHeartbeats).some(s => s.alive);
    // If no heartbeats yet but still in grace period, don't say dead
    const hasAnyData = Object.keys(agentHeartbeats).length > 0;
    return res.json({ alive: anyAlive || (inGrace && !hasAnyData), agents: agentHeartbeats });
  }
  // Agent sees own monitor or _default (untagged)
  const agentState = agentHeartbeats[agent] || agentHeartbeats['_default'];
  const alive = !!(agentState && agentState.alive) || (inGrace && !agentState);
  res.json({ alive });
});

// --- Serve raw PS1 monitor script (called by BAT installer) ---
app.get('/api/monitor-script', (req, res) => {
  const secret = req.query.secret || req.headers['x-webhook-secret'];
  if (secret !== WEBHOOK_SECRET) return res.status(403).send('Forbidden');
  const agent = req.query.agent || '';
  if (!agent || !USERS[agent]) return res.status(400).send('Invalid agent');
  const host = req.get('host');
  const protocol = req.protocol;
  const baseUrl = `${protocol}://${host}`;
  const script = generateMonitorScript(baseUrl, WEBHOOK_SECRET, agent);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.send(script);
});

// --- Download call monitor installer (pre-configured .bat, agent-specific) ---
app.get('/download/call-monitor', requireAuth, (req, res) => {
  const host = req.get('host');
  const protocol = req.protocol;
  const baseUrl = `${protocol}://${host}`;
  const agent = req.session.username;
  const bat = generateInstallerBat(baseUrl, WEBHOOK_SECRET, agent);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="Install_Call_Monitor_${agent}.bat"`);
  res.send(bat);
});

// --- Download WhatsApp extension (pre-configured zip) ---
app.get('/download/whatsapp-extension', requireAuth, (req, res) => {
  const extDir = path.join(__dirname, 'whatsapp-extension');
  if (!fs.existsSync(extDir)) {
    return res.status(404).send('WhatsApp extension not found');
  }

  const host = req.get('host');
  const protocol = req.protocol;
  const serverUrl = `${protocol}://${host}`;

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="WhatsApp_Extension.zip"');

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', err => res.status(500).send('Zip error: ' + err.message));
  archive.pipe(res);

  // Add all extension files, but patch background.js with the current server URL
  const files = fs.readdirSync(extDir);
  for (const file of files) {
    const filePath = path.join(extDir, file);
    if (!fs.statSync(filePath).isFile()) continue;

    if (file === 'background.js') {
      let content = fs.readFileSync(filePath, 'utf8');
      content = content.replace(
        /const DEFAULT_SERVER_URL = '[^']*'/,
        `const DEFAULT_SERVER_URL = '${serverUrl}'`
      );
      archive.append(content, { name: file });
    } else if (file === 'manifest.json') {
      let content = fs.readFileSync(filePath, 'utf8');
      const manifest = JSON.parse(content);
      const hostPerm = serverUrl.replace(/\/$/, '') + '/*';
      if (!manifest.host_permissions.includes(hostPerm)) {
        manifest.host_permissions.push(hostPerm);
      }
      archive.append(JSON.stringify(manifest, null, 2), { name: file });
    } else {
      archive.file(filePath, { name: file });
    }
  }

  archive.finalize();
});

function generateMonitorScript(baseUrl, secret, agent) {
  return `# Clinicea Call Monitor — Phone Link + WhatsApp
$ErrorActionPreference = 'Continue'
$webhookUrl = "${baseUrl}/incoming_call"
$heartbeatUrl = "${baseUrl}/heartbeat"
$webhookSecret = "${secret}"
$agentName = "${agent}"
$baseDir = "$env:APPDATA\\ClinicaCallMonitor"
$logFile = "$baseDir\\monitor.log"
$crashLog = "$baseDir\\crash.log"

if (-not (Test-Path $baseDir)) { New-Item -ItemType Directory -Path $baseDir -Force | Out-Null }

function Write-Log { param([string]$Msg)
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    try { Add-Content -Path $logFile -Value "[$ts] $Msg" -ErrorAction SilentlyContinue } catch {}
}

# Trim log if > 1MB
if (Test-Path $logFile) {
    try { if ((Get-Item $logFile).Length -gt 1MB) { Get-Content $logFile -Tail 200 | Set-Content "$logFile.tmp"; Move-Item "$logFile.tmp" $logFile -Force } } catch {}
}

if (-not $agentName) {
    Write-Log "FATAL: agentName is empty — this monitor was installed without an agent. Re-download from dashboard."
    Start-Sleep -Seconds 10
    exit 1
}
Write-Log "=== Monitor starting === Agent: $agentName"

# Send initial heartbeat immediately (before WinRT setup) so dashboard shows online
try {
    Invoke-RestMethod -Uri $heartbeatUrl -Method POST -Body "Agent=$([uri]::EscapeDataString($agentName))" -ContentType "application/x-www-form-urlencoded" -Headers @{ "X-Webhook-Secret" = $webhookSecret } -TimeoutSec 5 | Out-Null
    Write-Log "Initial heartbeat sent"
} catch { Write-Log "Initial heartbeat failed: $_" }

# Wrap all WinRT setup in a function so we can retry on crash
function Start-Monitor {
    try {
        [void][Windows.UI.Notifications.Management.UserNotificationListener, Windows.UI.Notifications, ContentType = WindowsRuntime]
        [void][Windows.UI.Notifications.NotificationKinds, Windows.UI.Notifications, ContentType = WindowsRuntime]
        [void][Windows.UI.Notifications.KnownNotificationBindings, Windows.UI.Notifications, ContentType = WindowsRuntime]
        [void][Windows.UI.Notifications.UserNotification, Windows.UI.Notifications, ContentType = WindowsRuntime]
        Write-Log "WinRT APIs loaded"
    } catch {
        Write-Log "ERROR: Cannot load WinRT APIs: $_"
        Add-Content -Path $crashLog -Value "[$(Get-Date)] WinRT load failed: $_" -ErrorAction SilentlyContinue
        return $false
    }

    try {
        Add-Type -AssemblyName System.Runtime.WindowsRuntime
    } catch {
        Write-Log "ERROR: Cannot load System.Runtime.WindowsRuntime: $_"
        Add-Content -Path $crashLog -Value "[$(Get-Date)] Runtime load failed: $_" -ErrorAction SilentlyContinue
        return $false
    }

    $asTaskGeneric = $null
    try {
        $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
            $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
            $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
        })[0]
        if (-not $asTaskGeneric) { throw "AsTask method not found" }
    } catch {
        Write-Log "ERROR: Cannot find AsTask generic method: $_"
        Add-Content -Path $crashLog -Value "[$(Get-Date)] AsTask reflection failed: $_" -ErrorAction SilentlyContinue
        return $false
    }

    function Await-AsyncOp { param($AsyncOp, [Type]$ResultType)
        $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
        $netTask = $asTask.Invoke($null, @($AsyncOp))
        $netTask.Wait(15000) | Out-Null
        return $netTask.Result
    }

    $listener = $null
    try {
        $listener = [Windows.UI.Notifications.Management.UserNotificationListener]::Current
        if (-not $listener) { throw "UserNotificationListener.Current returned null" }
    } catch {
        Write-Log "ERROR: Cannot get notification listener: $_"
        Add-Content -Path $crashLog -Value "[$(Get-Date)] Listener failed: $_" -ErrorAction SilentlyContinue
        return $false
    }

    $accessOk = $false
    for ($i = 1; $i -le 5; $i++) {
        try {
            $status = Await-AsyncOp ($listener.RequestAccessAsync()) ([Windows.UI.Notifications.Management.UserNotificationListenerAccessStatus])
            if ($status -eq [Windows.UI.Notifications.Management.UserNotificationListenerAccessStatus]::Allowed) {
                $accessOk = $true; Write-Log "Notification access granted"; break
            }
            Write-Log "Access attempt $i : $status"
        } catch { Write-Log "Access error (attempt $i): $_" }
        Start-Sleep -Seconds 3
    }
    if (-not $accessOk) {
        Write-Log "ERROR: Notification access denied. Enable at Settings > Privacy > Notifications"
        Add-Content -Path $crashLog -Value "[$(Get-Date)] Notification access denied after 5 attempts" -ErrorAction SilentlyContinue
        return $false
    }

    $seenIds = @{}; $recentCalls = @{}
    $lastHeartbeat = [DateTimeOffset]::Now.ToUnixTimeSeconds() - 999
    $consecutiveErrors = 0
    $startTime = [DateTimeOffset]::Now.ToUnixTimeSeconds()
    $lastNotifCount = -1
    Write-Log "Monitoring calls (Phone Link + WhatsApp)..."
    Write-Log "DIAGNOSTIC: Logging ALL notifications permanently"

    while ($true) {
        try {
            $notifications = Await-AsyncOp ($listener.GetNotificationsAsync([Windows.UI.Notifications.NotificationKinds]::Toast)) ([System.Collections.Generic.IReadOnlyList[Windows.UI.Notifications.UserNotification]])
            $consecutiveErrors = 0
            $totalCount = 0
            if ($notifications) { $totalCount = $notifications.Count }

            # Log notification count changes so we know the API is working
            if ($totalCount -ne $lastNotifCount) {
                Write-Log "DIAG: GetNotificationsAsync returned $totalCount notifications (was $lastNotifCount)"
                $lastNotifCount = $totalCount
            }

            foreach ($notif in $notifications) {
                $nid = $notif.Id
                if ($seenIds.ContainsKey($nid)) { continue }
                $seenIds[$nid] = $true

                # Get app name — try multiple methods
                $appName = ""
                $appId = ""
                try { $appName = $notif.AppInfo.DisplayInfo.DisplayName } catch {}
                try { $appId = $notif.AppInfo.Id } catch {}
                if (-not $appName) { $appName = "(unknown)" }

                # Get notification text — try binding first, then raw
                $fullText = ""
                $textParts = @()
                try {
                    $binding = $notif.Notification.Visual.GetBinding([Windows.UI.Notifications.KnownNotificationBindings]::ToastGeneric)
                    if ($binding) {
                        $textElements = $binding.GetTextElements()
                        foreach ($elem in $textElements) { $textParts += $elem.Text }
                        $fullText = $textParts -join " | "
                    }
                } catch { $fullText = "(binding error: $_)" }

                # DIAGNOSTIC: Log EVERY notification with full detail
                Write-Log "NOTIF [$appName] id=$appId : $fullText"

                # Match phone/call apps — extremely broad matching
                $appLower = $appName.ToLower()
                $isPhoneApp = $appLower -match "phone|link|tel|call|dialer|samsung|android|mobile|microsoft"
                $isWhatsApp = $appLower -match "whatsapp"
                if (-not $isPhoneApp -and -not $isWhatsApp) {
                    # Also check appId for Phone Link
                    if ($appId -match "PhoneExperienceHost|YourPhone|PhoneLink|Microsoft.YourPhone") {
                        $isPhoneApp = $true
                        Write-Log "MATCHED by appId: $appId"
                    }
                }
                if (-not $isPhoneApp -and -not $isWhatsApp) { continue }

                Write-Log ">>> PHONE APP MATCH [$appName] appId=$appId : $fullText"

                # Detect if this is a call — very broad matching on individual text parts too
                $isCall = $false
                $allTextLower = $fullText.ToLower()
                if ($isPhoneApp) {
                    $isCall = $allTextLower -match "incoming|call|calling|ringing|answer|decline|dial|ring|missed"
                }
                if ($isWhatsApp) {
                    $isCall = $allTextLower -match "voice call|video call|incoming|calling|ringing|audio call"
                }

                # Also check individual text elements for call indicators
                if (-not $isCall -and $isPhoneApp) {
                    foreach ($part in $textParts) {
                        if ($part.ToLower() -match "incoming|call|calling|ringing|answer|decline|ring|missed") {
                            $isCall = $true
                            Write-Log "Call keyword found in text part: $part"
                            break
                        }
                    }
                }

                # Fallback: ANY phone app notification with a phone number pattern = treat as call
                if (-not $isCall -and $isPhoneApp) {
                    if ($fullText -match '(\+?[\d][\d\s\-\(\)]{6,18}[\d])') {
                        Write-Log "POSSIBLE CALL (number without keywords) [$appName]: $fullText"
                        $isCall = $true
                    }
                }

                # LAST RESORT: if it is from Phone Link and has any content, treat as potential call
                if (-not $isCall -and ($appLower -match "phone link" -or $appId -match "PhoneExperienceHost|YourPhone")) {
                    Write-Log "FORCE TREATING as call (Phone Link app, any content): $fullText"
                    $isCall = $true
                }

                if ($isCall) {
                    try {
                        Write-Log "=== CALL DETECTED [$appName]: $fullText ==="

                        # Try to extract phone number from all available text
                        $phone = $null

                        # Method 1: strip call keywords then find number
                        $stripped = $fullText -replace '(?i)(incoming\s*(voice\s*|video\s*|audio\s*)?(call)?|calling|ringing|answer|decline|voice\s*call|video\s*call|audio\s*call|missed call)', ''
                        $stripped = $stripped -replace '\|', ' '
                        $stripped = $stripped.Trim()
                        if ($stripped -match '(\+?[\d][\d\s\-\(\)]{6,18}[\d])') {
                            $phone = $Matches[1] -replace '[\s\-\(\)]', ''
                        }

                        # Method 2: search original full text
                        if (-not $phone) {
                            if ($fullText -match '(\+?[\d][\d\s\-\(\)]{6,18}[\d])') {
                                $phone = $Matches[1] -replace '[\s\-\(\)]', ''
                                Write-Log "Phone from fullText fallback: $phone"
                            }
                        }

                        # Method 3: search each text part individually
                        if (-not $phone) {
                            foreach ($part in $textParts) {
                                if ($part -match '(\+?[\d][\d\s\-\(\)]{6,18}[\d])') {
                                    $phone = $Matches[1] -replace '[\s\-\(\)]', ''
                                    Write-Log "Phone from text part: $phone (part: $part)"
                                    break
                                }
                            }
                        }

                        # If still no phone, use contact name as identifier
                        if (-not $phone) {
                            # Use first text element as contact identifier
                            if ($textParts.Count -gt 0 -and $textParts[0].Length -gt 0) {
                                $phone = "contact:" + $textParts[0].Trim()
                                Write-Log "No phone number found — using contact name: $phone"
                            } else {
                                $phone = "unknown-" + [DateTimeOffset]::Now.ToUnixTimeSeconds()
                                Write-Log "No phone or contact found — using fallback: $phone"
                            }
                        }

                        $now = [DateTimeOffset]::Now.ToUnixTimeSeconds()
                        if ($recentCalls.ContainsKey($phone) -and ($now - $recentCalls[$phone]) -lt 30) {
                            Write-Log "Skipping duplicate: $phone (within 30s)"
                            continue
                        }
                        $recentCalls[$phone] = $now
                        Write-Log "SENDING WEBHOOK: $phone -> $webhookUrl"
                        $body = "From=$([uri]::EscapeDataString($phone))&CallSid=local-$now&Agent=$([uri]::EscapeDataString($agentName))"
                        for ($wRetry = 1; $wRetry -le 3; $wRetry++) {
                            try {
                                $resp = Invoke-RestMethod -Uri $webhookUrl -Method POST -Body $body -ContentType "application/x-www-form-urlencoded" -Headers @{ "X-Webhook-Secret" = $webhookSecret } -TimeoutSec 10
                                Write-Log "Webhook OK (attempt $wRetry)"
                                break
                            } catch {
                                Write-Log "Webhook FAIL (attempt $wRetry): $_"
                                if ($wRetry -lt 3) { Start-Sleep -Seconds 2 }
                            }
                        }
                    } catch { Write-Log "Call processing error: $_" }
                }
            }
            if ($seenIds.Count -gt 1000) { $seenIds = @{} }
            $now = [DateTimeOffset]::Now.ToUnixTimeSeconds()
            $expired = @($recentCalls.Keys | Where-Object { ($now - $recentCalls[$_]) -gt 60 })
            foreach ($k in $expired) { $recentCalls.Remove($k) }
        } catch {
            $consecutiveErrors++
            Write-Log "Loop error ($consecutiveErrors): $_"
            if ($consecutiveErrors -ge 10) {
                Write-Log "Too many consecutive errors, restarting monitor..."
                Add-Content -Path $crashLog -Value "[$(Get-Date)] Restarting after $consecutiveErrors consecutive errors: $_" -ErrorAction SilentlyContinue
                return $false
            }
        }

        $now = [DateTimeOffset]::Now.ToUnixTimeSeconds()
        if (($now - $lastHeartbeat) -ge 30) {
            $hbOk = $false
            for ($hbRetry = 1; $hbRetry -le 3; $hbRetry++) {
                try {
                    Invoke-RestMethod -Uri $heartbeatUrl -Method POST -Body "Agent=$([uri]::EscapeDataString($agentName))" -ContentType "application/x-www-form-urlencoded" -Headers @{ "X-Webhook-Secret" = $webhookSecret } -TimeoutSec 10 | Out-Null
                    $lastHeartbeat = $now
                    $hbOk = $true
                    break
                } catch {
                    Write-Log "Heartbeat attempt $hbRetry failed: $_"
                    if ($hbRetry -lt 3) { Start-Sleep -Seconds 2 }
                }
            }
            if (-not $hbOk) { Write-Log "WARNING: All 3 heartbeat attempts failed — server may be down" }
            # Upload last 50 lines of log to server so it can be viewed remotely
            try {
                $logUploadUrl = $heartbeatUrl -replace '/heartbeat$', '/api/monitor-log'
                $tail = ""
                if (Test-Path $logFile) { $tail = (Get-Content $logFile -Tail 50) -join [char]10 }
                Invoke-RestMethod -Uri $logUploadUrl -Method POST -Body "Agent=$([uri]::EscapeDataString($agentName))&Log=$([uri]::EscapeDataString($tail))" -ContentType "application/x-www-form-urlencoded" -Headers @{ "X-Webhook-Secret" = $webhookSecret } -TimeoutSec 5 | Out-Null
            } catch {}
        }
        Start-Sleep -Seconds 1
    }
    return $true
}

# Auto-restart loop — if monitor crashes, wait and retry (up to 20 times)
$maxRestarts = 20
for ($restart = 0; $restart -lt $maxRestarts; $restart++) {
    if ($restart -gt 0) {
        $waitSec = [Math]::Min(30, 5 * $restart)
        Write-Log "Restarting monitor in $waitSec seconds (attempt $($restart + 1) / $maxRestarts)..."
        # Keep sending heartbeats while waiting to restart
        try {
            Invoke-RestMethod -Uri $heartbeatUrl -Method POST -Body "Agent=$([uri]::EscapeDataString($agentName))" -ContentType "application/x-www-form-urlencoded" -Headers @{ "X-Webhook-Secret" = $webhookSecret } -TimeoutSec 5 | Out-Null
        } catch {}
        Start-Sleep -Seconds $waitSec
    }
    $result = Start-Monitor
    if ($result -eq $true) { break }
}
Write-Log "Monitor exiting after $maxRestarts restart attempts. Please re-install."
`;
}

function generateInstallerBat(baseUrl, secret, agent) {
  let bat = '@echo off\r\n';
  bat += 'setlocal EnableExtensions EnableDelayedExpansion\r\n';
  bat += 'title Clinicea Call Monitor Installer - ' + agent + '\r\n';
  bat += '\r\n';
  bat += 'set "AGENT=' + agent + '"\r\n';
  bat += 'set "SERVER_URL=' + baseUrl + '"\r\n';
  bat += 'set "WEBHOOK_SECRET=' + secret + '"\r\n';
  bat += '\r\n';
  bat += 'set "APP_DIR=%APPDATA%\\ClinicaCallMonitor"\r\n';
  bat += 'set "PS1_FILE=%APP_DIR%\\call_monitor.ps1"\r\n';
  bat += 'set "VBS_FILE=%APP_DIR%\\start_monitor.vbs"\r\n';
  bat += 'set "LOG_FILE=%APP_DIR%\\install_%AGENT%.log"\r\n';
  bat += 'set "TASK_NAME=Clinicea Call Monitor - %AGENT%"\r\n';
  bat += '\r\n';
  bat += 'if not exist "%APP_DIR%" mkdir "%APP_DIR%"\r\n';
  bat += '\r\n';
  bat += 'call :log "Starting installer for %AGENT%"\r\n';
  bat += 'echo.\r\n';
  bat += 'echo === Clinicea Call Monitor Installer ===\r\n';
  bat += 'echo Agent: %AGENT%\r\n';
  bat += 'echo.\r\n';
  bat += '\r\n';

  // Step 1: Stop old monitor — all PowerShell on single lines
  bat += 'echo [1/7] Stopping previous monitor instance...\r\n';
  bat += 'call :log "Stopping old monitor task/process if present"\r\n';
  bat += 'schtasks /Query /TN "%TASK_NAME%" >nul 2>&1 && schtasks /End /TN "%TASK_NAME%" >nul 2>&1\r\n';
  bat += 'powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq \'powershell.exe\' -and $_.CommandLine -like \'*call_monitor.ps1*\' } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force } catch {} }" >> "%LOG_FILE%" 2>&1\r\n';
  bat += 'echo Done.\r\n';
  bat += '\r\n';

  // Step 2: Download PS1 — single-line PowerShell
  bat += 'echo [2/7] Downloading monitor script...\r\n';
  bat += 'call :log "Downloading call_monitor.ps1"\r\n';
  bat += 'powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; $url = \'%SERVER_URL%/api/monitor-script?agent=%AGENT%&secret=%WEBHOOK_SECRET%\'; Invoke-WebRequest -Uri $url -OutFile \'%PS1_FILE%\' -UseBasicParsing; if (!(Test-Path \'%PS1_FILE%\')) { exit 11 }; $len = (Get-Item \'%PS1_FILE%\').Length; if ($len -lt 100) { exit 12 }; Write-Output (\'Downloaded bytes=\' + $len)" >> "%LOG_FILE%" 2>&1\r\n';
  bat += 'if not exist "%PS1_FILE%" (\r\n';
  bat += '    echo ERROR: Failed to download monitor script.\r\n';
  bat += '    call :log "ERROR: Monitor script missing after download"\r\n';
  bat += '    pause\r\n';
  bat += '    exit /b 1\r\n';
  bat += ')\r\n';
  bat += 'for %%A in ("%PS1_FILE%") do set "PS1_SIZE=%%~zA"\r\n';
  bat += 'if "%PS1_SIZE%"=="0" (\r\n';
  bat += '    echo ERROR: Downloaded script is empty.\r\n';
  bat += '    pause\r\n';
  bat += '    exit /b 1\r\n';
  bat += ')\r\n';
  bat += 'echo Downloaded script size: %PS1_SIZE% bytes\r\n';
  bat += 'call :log "Downloaded script size: %PS1_SIZE% bytes"\r\n';
  bat += '\r\n';

  // Step 3: Write VBS launcher via batch echo (these lines have no special chars issues)
  bat += 'echo [3/7] Writing silent launcher...\r\n';
  bat += 'call :log "Writing VBS launcher"\r\n';
  bat += '> "%VBS_FILE%" echo Set ws = CreateObject("WScript.Shell")\r\n';
  bat += '>> "%VBS_FILE%" echo appDir = ws.ExpandEnvironmentStrings("%APPDATA%") ^& "\\ClinicaCallMonitor"\r\n';
  bat += '>> "%VBS_FILE%" echo ws.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ ^& appDir ^& "\\call_monitor.ps1""", 0, False\r\n';
  bat += 'if not exist "%VBS_FILE%" (\r\n';
  bat += '    echo ERROR: Failed to create VBS launcher.\r\n';
  bat += '    pause\r\n';
  bat += '    exit /b 1\r\n';
  bat += ')\r\n';
  bat += 'echo Done.\r\n';
  bat += '\r\n';

  // Step 4: Scheduled task — single line
  bat += 'echo [4/7] Creating scheduled task...\r\n';
  bat += 'call :log "Creating scheduled task: %TASK_NAME%"\r\n';
  bat += 'schtasks /Delete /TN "%TASK_NAME%" /F >nul 2>&1\r\n';
  bat += 'schtasks /Create /TN "%TASK_NAME%" /SC ONLOGON /RL HIGHEST /TR "wscript.exe \\"%VBS_FILE%\\"" /F >> "%LOG_FILE%" 2>&1\r\n';
  bat += 'if errorlevel 1 (\r\n';
  bat += '    echo WARNING: Scheduled task failed - will use startup folder instead.\r\n';
  bat += '    call :log "WARNING: Scheduled task creation failed"\r\n';
  bat += ')\r\n';
  bat += 'echo Done.\r\n';
  bat += '\r\n';

  // Step 5: Startup folder fallback
  bat += 'echo [5/7] Adding startup-folder fallback...\r\n';
  bat += 'call :log "Adding startup folder fallback"\r\n';
  bat += 'copy /Y "%VBS_FILE%" "%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\CliniceaCallMonitor_%AGENT%.vbs" >nul 2>&1\r\n';
  bat += 'echo Done.\r\n';
  bat += '\r\n';

  // Step 6: Start monitor
  bat += 'echo [6/7] Starting monitor...\r\n';
  bat += 'call :log "Starting monitor immediately"\r\n';
  bat += 'start "" wscript.exe "%VBS_FILE%"\r\n';
  bat += 'timeout /t 2 /nobreak >nul\r\n';
  bat += 'echo Done.\r\n';
  bat += '\r\n';

  // Step 7: Final status
  bat += 'echo [7/7] Installation complete.\r\n';
  bat += 'call :log "Installation complete"\r\n';
  bat += 'echo.\r\n';
  bat += 'echo ============================================\r\n';
  bat += 'echo Installation complete\r\n';
  bat += 'echo Agent:      %AGENT%\r\n';
  bat += 'echo Dashboard:  %SERVER_URL%\r\n';
  bat += 'echo Install dir:%APP_DIR%\r\n';
  bat += 'echo Log file:   %LOG_FILE%\r\n';
  bat += 'echo ============================================\r\n';
  bat += 'echo.\r\n';
  bat += 'pause\r\n';
  bat += 'exit /b 0\r\n';
  bat += '\r\n';
  bat += ':log\r\n';
  bat += 'echo [%date% %time%] %~1>> "%LOG_FILE%"\r\n';
  bat += 'goto :eof\r\n';

  return bat;
}

// --- Public WhatsApp API Routes (no auth — called by Chrome Extension) ---
// These MUST be before the static middleware which requires auth

// Paused chats — bot won't reply to these
const pausedChats = new Set();

// Incoming message from WhatsApp (via extension)
app.post('/api/whatsapp/incoming', async (req, res) => {
  const { messageId, text, phone, chatName, timestamp } = req.body;

  if (!text || (!phone && !chatName)) {
    return res.json({ reply: null });
  }

  const contactId = phone || chatName || 'unknown';
  logEvent('info', `WA message from ${chatName || phone}: ${text.substring(0, 50)}`);

  // Store incoming message
  insertWaMessage.run(contactId, chatName || null, 'in', text, 'chat', 'sent', null);

  // Check if bot is paused for this chat
  if (pausedChats.has(contactId) || pausedChats.has(chatName)) {
    logEvent('info', `WA bot paused for ${chatName || phone}, skipping reply`);
    io.emit('wa_message', { phone: contactId, chatName, direction: 'in', text, reply: null, timestamp: new Date().toISOString() });
    return res.json({ reply: null });
  }

  // Get GPT reply
  const reply = await getGPTReply(contactId, text, chatName);

  // Store outgoing reply
  insertWaMessage.run(contactId, chatName || null, 'out', reply, 'chat', 'sent', null);

  logEvent('info', `WA reply to ${chatName || phone}: ${reply.substring(0, 50)}`);
  io.emit('wa_message', { phone: contactId, chatName, direction: 'in', text, reply, timestamp: new Date().toISOString() });

  return res.json({ reply });
});

// Poll for pending outgoing messages (confirmations, reminders)
app.get('/api/whatsapp/outgoing', (req, res) => {
  const pending = getPendingOutgoing.all();
  const messages = pending.map(m => ({
    id: m.id,
    phone: m.phone,
    text: m.message,
    type: m.message_type
  }));
  return res.json({ messages });
});

// Confirm a message was sent by the extension
app.post('/api/whatsapp/sent', (req, res) => {
  const { id, phone, success } = req.body;
  if (id) {
    if (success) {
      markMessageSent.run(id);
      logEvent('info', `WA scheduled message delivered to ${phone}`);
    } else {
      markMessageFailed.run(id);
      logEvent('warn', `WA scheduled message failed for ${phone}`);
    }
  }
  return res.json({ ok: true });
});

// Protected dashboard - serve static files behind auth
app.get('/', requireAuth, (req, res, next) => next());
app.use(requireAuth, express.static(path.join(__dirname, 'public')));

// API - paginated call history
app.get('/api/calls', requireAuth, (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || PAGE_SIZE));
  const offset = (page - 1) * limit;
  const isAdmin = req.session.role === 'admin';
  const agent = req.session.username;

  let total, calls;
  if (isAdmin) {
    total = db.prepare('SELECT COUNT(*) as total FROM calls').get().total;
    calls = db.prepare('SELECT * FROM calls ORDER BY timestamp DESC LIMIT ? OFFSET ?').all(limit, offset);
  } else {
    total = db.prepare('SELECT COUNT(*) as total FROM calls WHERE agent = ?').get(agent).total;
    calls = db.prepare('SELECT * FROM calls WHERE agent = ? ORDER BY timestamp DESC LIMIT ? OFFSET ?').all(agent, limit, offset);
  }
  res.json({ calls, total, page, totalPages: Math.ceil(total / limit) });
});

// --- Clinicea API Integration ---
let cliniceaToken = null;
let tokenExpiry = 0;
const meetingCache = new Map(); // phone -> { data, expiry }
const appointmentDateCache = new Map(); // date -> { data, expiry }
const profileCache = new Map(); // patientID -> { data, expiry }
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function isClinicaConfigured() {
  return CLINICEA_API_KEY && CLINICEA_API_KEY !== 'your_api_key_here' &&
         CLINICEA_STAFF_USERNAME && CLINICEA_STAFF_USERNAME !== 'your_staff_username_here' &&
         CLINICEA_STAFF_PASSWORD && CLINICEA_STAFF_PASSWORD !== 'your_staff_password_here';
}

async function cliniceaLogin() {
  const url = `${CLINICEA_API_BASE}/api/v2/login/getTokenByStaffUsernamePwd?apiKey=${encodeURIComponent(CLINICEA_API_KEY)}&loginUserName=${encodeURIComponent(CLINICEA_STAFF_USERNAME)}&pwd=${encodeURIComponent(CLINICEA_STAFF_PASSWORD)}`;
  const res = await fetch(url);
  if (!res.ok) {
    logEvent('error', 'Clinicea API login failed', 'HTTP ' + res.status);
    throw new Error('Clinicea login failed: ' + res.status);
  }
  const data = await res.json();
  // Token is returned as a plain string
  cliniceaToken = typeof data === 'string' ? data : (data.Token || data.token || data.sessionId);
  tokenExpiry = Date.now() + 55 * 60 * 1000;
  logEvent('info', 'Clinicea API login successful');
  return cliniceaToken;
}

async function getClinicaToken() {
  if (!cliniceaToken || Date.now() > tokenExpiry) {
    await cliniceaLogin();
  }
  return cliniceaToken;
}

// Clinicea uses api_key as query parameter for auth (NOT Bearer header)
async function cliniceaFetch(endpoint) {
  const token = await getClinicaToken();
  const separator = endpoint.includes('?') ? '&' : '?';
  const url = `${CLINICEA_API_BASE}${endpoint}${separator}api_key=${token}`;
  const res = await fetch(url);
  if (res.status === 401) {
    await cliniceaLogin();
    const retryUrl = `${CLINICEA_API_BASE}${endpoint}${separator}api_key=${cliniceaToken}`;
    const retryRes = await fetch(retryUrl);
    if (retryRes.status === 204) return [];
    const retryText = await retryRes.text();
    try { return JSON.parse(retryText); } catch { return []; }
  }
  if (res.status === 204) return [];
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    logEvent('warn', 'Clinicea API returned non-JSON', text.substring(0, 100));
    return [];
  }
}

// Find patient by phone — tries v2/getPatient direct search first, then appointment matching
async function findPatientByPhone(phone) {
  const cleanPhone = phone.replace(/[\s\-\(\)]/g, '');
  // Extract local number (without country code) for Clinicea search
  let localNum = cleanPhone.replace('+', '');
  if (localNum.startsWith('92')) localNum = localNum.substring(2);
  else if (localNum.startsWith('0')) localNum = localNum.substring(1);

  logEvent('info', 'Looking up phone: ' + cleanPhone, 'Local: ' + localNum);

  // Method 1 (most reliable): v2/getPatient — searches by mobile with country code
  try {
    const data = await cliniceaFetch(`/api/v2/patients/getPatient?searchBy=2&searchText=${encodeURIComponent(localNum)}&searchOption=%2B92`);
    console.log(`[SEARCH] v2/getPatient(${localNum}) =>`, JSON.stringify(data).substring(0, 400));
    const result = extractPatientFromSearch(data);
    if (result) {
      logEvent('info', 'Patient found via v2/getPatient: ' + result.patientName, 'ID: ' + result.patientID);
      return result;
    }
  } catch (e) {
    console.log(`[SEARCH] v2/getPatient error:`, e.message);
  }

  // Method 2: appointment-based matching (works when phone format matches exactly)
  try {
    const today = new Date();
    const thirtyDaysAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
    const syncDate = thirtyDaysAgo.toISOString().split('.')[0];
    const data = await cliniceaFetch(`/api/v2/appointments/getChanges?lastSyncDTime=${syncDate}&pageNo=1&pageSize=100`);
    if (Array.isArray(data)) {
      const variants = new Set();
      variants.add(cleanPhone);
      variants.add(cleanPhone.replace('+', ''));
      if (cleanPhone.startsWith('0')) {
        variants.add('92' + cleanPhone.substring(1));
        variants.add('+92' + cleanPhone.substring(1));
      }
      if (cleanPhone.startsWith('+92')) {
        variants.add('0' + cleanPhone.substring(3));
        variants.add(cleanPhone.substring(1));
      }
      if (cleanPhone.startsWith('92') && !cleanPhone.startsWith('+')) {
        variants.add('+' + cleanPhone);
        variants.add('0' + cleanPhone.substring(2));
      }

      const match = data.find(a => {
        const p1 = (a.AppointmentWithPhone || '').replace(/[\s\-\(\)]/g, '');
        const p2 = (a.PatientMobile || '').replace(/[\s\-\(\)]/g, '');
        return variants.has(p1) || variants.has(p2);
      });

      if (match) {
        let patientName = match.AppointmentWithName || match.PatientName || null;
        if (!patientName) {
          const first = match.PatientFirstName || match.FirstName || '';
          const last = match.PatientLastName || match.LastName || '';
          patientName = [first, last].filter(Boolean).join(' ') || null;
        }
        logEvent('info', 'Patient found via appointments: ' + patientName, 'ID: ' + match.PatientID);
        return { patientID: match.PatientID, patientName };
      }
    }
  } catch (e) {
    console.log(`[SEARCH] getChanges error:`, e.message);
  }

  return null;
}

function extractPatientId(obj) {
  // Clinicea uses different field names across API versions
  // v2/getPatient uses "ID", appointments use "PatientID"
  return obj.PatientID || obj.patientID || obj.PatientId || obj.ID || obj.QDID ||
         obj.EntityID || obj.entityID || obj.Id || obj.id || obj.UniqueID || obj.PatientGUID || null;
}

function extractPatientFromSearch(data) {
  // Log raw response keys for debugging
  if (data && !Array.isArray(data) && typeof data === 'object') {
    console.log('[SEARCH] Response keys:', Object.keys(data).join(', '));
    console.log('[SEARCH] Response sample:', JSON.stringify(data).substring(0, 500));
  }
  if (Array.isArray(data) && data.length > 0) {
    console.log('[SEARCH] Array[0] keys:', Object.keys(data[0]).join(', '));
    console.log('[SEARCH] Array[0] sample:', JSON.stringify(data[0]).substring(0, 500));
  }

  if (data && !Array.isArray(data) && typeof data === 'object') {
    const pid = extractPatientId(data);
    if (pid) {
      const name = data.FullName || data.Name || data.PatientName || [data.FirstName, data.LastName].filter(Boolean).join(' ') || null;
      logEvent('info', 'Patient found via search: ' + (name || 'Unknown'), 'ID: ' + pid);
      return { patientID: pid, patientName: name };
    }
  }
  if (Array.isArray(data) && data.length > 0) {
    const pat = data[0];
    const pid = extractPatientId(pat);
    if (pid) {
      const name = pat.FullName || pat.Name || pat.PatientName || [pat.FirstName, pat.LastName].filter(Boolean).join(' ') || null;
      logEvent('info', 'Patient found via search: ' + (name || 'Unknown'), 'ID: ' + pid);
      return { patientID: pid, patientName: name };
    }
  }
  return null;
}

async function getNextAppointmentForPatient(patientID) {
  // appointmentType=0 means upcoming, pageSize minimum is 10
  const data = await cliniceaFetch(`/api/v2/appointments/getAppointmentsByPatient?patientID=${patientID}&appointmentType=0&pageNo=1&pageSize=10`);
  if (!Array.isArray(data) || data.length === 0) return null;
  // Sort by StartDateTime ascending and return the earliest upcoming
  const now = new Date();
  const upcoming = data
    .filter(a => new Date(a.StartDateTime) >= now && a.AppointmentStatus !== 'Cancelled')
    .sort((a, b) => new Date(a.StartDateTime) - new Date(b.StartDateTime));
  return upcoming[0] || data[0];
}

// API - next meeting for a phone number
app.get('/api/next-meeting/:phone', requireAuth, async (req, res) => {
  const phone = decodeURIComponent(req.params.phone);

  if (!isClinicaConfigured()) {
    return res.json({ nextMeeting: null, error: 'Clinicea API not configured' });
  }

  // Check cache
  const cached = meetingCache.get(phone);
  if (cached && Date.now() < cached.expiry) {
    return res.json(cached.data);
  }

  try {
    const patient = await findPatientByPhone(phone);

    if (!patient) {
      const result = { nextMeeting: null, patientName: null };
      meetingCache.set(phone, { data: result, expiry: Date.now() + CACHE_TTL });
      return res.json(result);
    }

    const appointment = await getNextAppointmentForPatient(patient.patientID);
    const result = { nextMeeting: appointment, patientName: patient.patientName };
    meetingCache.set(phone, { data: result, expiry: Date.now() + CACHE_TTL });
    return res.json(result);
  } catch (err) {
    logEvent('error', 'Clinicea API error', err.message);
    return res.json({ nextMeeting: null, patientName: null, error: err.message });
  }
});

// Shared profile fetcher with cache (used by both phone and ID endpoints)
async function fetchProfileByPatientId(patientId) {
  const cached = profileCache.get(patientId);
  if (cached && Date.now() < cached.expiry) return cached.data;

  const [details, appointments, bills] = await Promise.all([
    cliniceaFetch(`/api/v3/patients/getPatientByID?patientID=${patientId}`),
    cliniceaFetch(`/api/v2/appointments/getAppointmentsByPatient?patientID=${patientId}&appointmentType=2&pageNo=1&pageSize=50`),
    cliniceaFetch(`/api/v2/bills/getBillsByPatient?patientID=${patientId}&billStatus=0&pageNo=1&pageSize=50`)
  ]);

  const pat = Array.isArray(details) ? (details[0] || {}) : (details || {});
  const patientName = pat.Name || pat.PatientName || pat.FullName ||
                      [pat.FirstName, pat.LastName].filter(Boolean).join(' ') || 'Unknown';

  const result = {
    patient: details,
    appointments: Array.isArray(appointments) ? appointments : [],
    bills: Array.isArray(bills) ? bills : [],
    patientName,
    patientID: patientId
  };

  profileCache.set(patientId, { data: result, expiry: Date.now() + CACHE_TTL });
  return result;
}

// API - full patient profile from Clinicea (by phone)
app.get('/api/patient-profile/:phone', requireAuth, async (req, res) => {
  const phone = decodeURIComponent(req.params.phone);

  if (!isClinicaConfigured()) {
    return res.json({ error: 'Clinicea API not configured' });
  }

  try {
    const patient = await findPatientByPhone(phone);
    if (!patient || !patient.patientID) {
      return res.json({ error: 'Patient not found in Clinicea' });
    }

    const result = await fetchProfileByPatientId(patient.patientID);
    return res.json(result);
  } catch (err) {
    logEvent('error', 'Patient profile fetch failed', err.message);
    return res.json({ error: err.message });
  }
});

// --- Patient list cache (avoids re-fetching from Clinicea on every search) ---
let patientCache = { patients: [], expiry: 0, loading: false, pages: 0 };
const PATIENT_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

function mapPatientFields(p) {
  return {
    patientID: extractPatientId(p),
    name: p.Name || p.PatientName || p.FullName || [p.FirstName, p.LastName].filter(Boolean).join(' ') || 'Unknown',
    phone: p.Mobile || p.MobilePhone || p.PatientMobile || p.Phone || '',
    email: p.Email || p.EmailAddress || '',
    fileNo: p.FileNo || '',
    gender: p.Gender || '',
    createdDate: p.CreatedDatetime || p.CreatedDate || ''
  };
}

async function loadAllPatients() {
  if (patientCache.loading) return;
  patientCache.loading = true;
  const allPatients = [];
  let pageNo = 1;
  try {
    while (true) {
      const data = await cliniceaFetch(`/api/v1/patients?lastSyncDate=2000-01-01T00:00:00&intPageNo=${pageNo}`);
      const batch = Array.isArray(data) ? data : [];
      allPatients.push(...batch.map(mapPatientFields));
      if (batch.length < 100) break; // last page
      pageNo++;
      if (pageNo > 50) break; // safety limit (5000 patients max)
    }
    patientCache = { patients: allPatients, expiry: Date.now() + PATIENT_CACHE_TTL, loading: false, pages: pageNo };
    logEvent('info', `Patient cache loaded: ${allPatients.length} patients (${pageNo} pages)`);
  } catch (err) {
    patientCache.loading = false;
    logEvent('error', 'Patient cache load failed', err.message);
    throw err;
  }
}

// API - list all patients (cached, with search)
app.get('/api/patients', requireAuth, async (req, res) => {
  const search = (req.query.search || '').trim().toLowerCase();
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = 25;

  if (!isClinicaConfigured()) {
    return res.json({ error: 'Clinicea API not configured', patients: [], total: 0 });
  }

  try {
    // Load/refresh cache if stale
    if (Date.now() > patientCache.expiry && !patientCache.loading) {
      await loadAllPatients();
    } else if (patientCache.loading) {
      // Still loading from another request — return what we have or wait briefly
      return res.json({ patients: [], page: 1, hasMore: false, loading: true });
    }

    let patients = patientCache.patients;

    // Filter by search
    if (search) {
      patients = patients.filter(p =>
        p.name.toLowerCase().includes(search) ||
        p.phone.toLowerCase().includes(search) ||
        p.email.toLowerCase().includes(search) ||
        (p.fileNo && p.fileNo.toLowerCase().includes(search))
      );
    }

    // Paginate
    const total = patients.length;
    const start = (page - 1) * pageSize;
    const sliced = patients.slice(start, start + pageSize);

    return res.json({ patients: sliced, page, hasMore: start + pageSize < total, total });
  } catch (err) {
    logEvent('error', 'Patients list fetch failed', err.message);
    return res.json({ error: err.message, patients: [], total: 0 });
  }
});

// API - appointments by date (cached)
function mapAppointmentFields(a) {
  return {
    appointmentID: a.AppointmentID || a.ID || a.Id,
    patientID: a.PatientID || a.patientID,
    patientName: a.AppointmentWithName || a.PatientName || [a.PatientFirstName || a.FirstName, a.PatientLastName || a.LastName].filter(Boolean).join(' ') || 'Unknown',
    startTime: a.StartDateTime || a.AppointmentDateTime || a.StartTime || '',
    endTime: a.EndDateTime || a.EndTime || '',
    duration: a.Duration || null,
    status: a.AppointmentStatus || a.Status || 'Unknown',
    service: a.ServiceName || a.Service || '',
    doctor: a.DoctorName || a.Doctor || '',
    phone: a.AppointmentWithPhone || a.PatientMobile || a.Mobile || '',
    notes: a.Notes || a.AppointmentNotes || ''
  };
}

app.get('/api/appointments-by-date', requireAuth, async (req, res) => {
  const date = req.query.date;
  if (!date) {
    return res.json({ error: 'date parameter required', appointments: [] });
  }

  if (!isClinicaConfigured()) {
    return res.json({ error: 'Clinicea API not configured', appointments: [] });
  }

  // Check cache (skip if refresh=1)
  const forceRefresh = req.query.refresh === '1';
  const cached = appointmentDateCache.get(date);
  if (cached && Date.now() < cached.expiry && !forceRefresh) {
    return res.json({ appointments: cached.data, date });
  }

  try {
    const data = await cliniceaFetch(`/api/v3/appointments/getAppointmentsByDate?appointmentDate=${encodeURIComponent(date)}&pageNo=1&pageSize=100`);
    logEvent('info', `Clinicea appointments raw response for ${date}`, `type=${typeof data}, isArray=${Array.isArray(data)}, length=${Array.isArray(data) ? data.length : 'N/A'}, preview=${JSON.stringify(data).substring(0, 300)}`);
    const appointments = (Array.isArray(data) ? data : []).map(mapAppointmentFields);

    appointmentDateCache.set(date, { data: appointments, expiry: Date.now() + CACHE_TTL });
    return res.json({ appointments, date });
  } catch (err) {
    logEvent('error', 'Appointments by date fetch failed', err.message);
    return res.json({ error: err.message, appointments: [] });
  }
});

// API - patient profile by patient ID (not phone)
app.get('/api/patient-profile-by-id/:patientId', requireAuth, async (req, res) => {
  const patientId = req.params.patientId;

  if (!isClinicaConfigured()) {
    return res.json({ error: 'Clinicea API not configured' });
  }

  try {
    const result = await fetchProfileByPatientId(patientId);
    return res.json(result);
  } catch (err) {
    logEvent('error', 'Patient profile by ID fetch failed', err.message);
    return res.json({ error: err.message });
  }
});

// API - event log history
app.get('/api/logs', requireAuth, (req, res) => {
  res.json({ logs: eventLog });
});

// =========================================================
// --- WhatsApp Bot + GPT + Appointment Reminders ---
// =========================================================

// --- WhatsApp DB Tables ---
db.exec(`
  CREATE TABLE IF NOT EXISTS wa_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL,
    chat_name TEXT,
    direction TEXT NOT NULL, -- 'in' or 'out'
    message TEXT NOT NULL,
    message_type TEXT DEFAULT 'chat', -- 'chat', 'confirmation', 'reminder'
    status TEXT DEFAULT 'sent', -- 'sent', 'pending', 'failed'
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS wa_appointment_tracking (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    appointment_id TEXT UNIQUE NOT NULL,
    patient_id TEXT,
    patient_name TEXT,
    patient_phone TEXT,
    appointment_date TEXT,
    doctor_name TEXT,
    service TEXT,
    confirmation_sent INTEGER DEFAULT 0,
    reminder_sent INTEGER DEFAULT 0,
    confirmation_sent_at DATETIME,
    reminder_sent_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

try { db.exec('ALTER TABLE wa_messages ADD COLUMN agent TEXT'); } catch (e) { /* already exists */ }

const insertWaMessage = db.prepare(
  'INSERT INTO wa_messages (phone, chat_name, direction, message, message_type, status, agent) VALUES (?, ?, ?, ?, ?, ?, ?)'
);
const getPendingOutgoing = db.prepare(
  "SELECT * FROM wa_messages WHERE direction = 'out' AND status = 'pending' ORDER BY created_at ASC LIMIT 5"
);
const markMessageSent = db.prepare(
  "UPDATE wa_messages SET status = 'sent' WHERE id = ?"
);
const markMessageFailed = db.prepare(
  "UPDATE wa_messages SET status = 'failed' WHERE id = ?"
);
const getConversationHistory = db.prepare(
  "SELECT direction, message, created_at FROM wa_messages WHERE phone = ? ORDER BY created_at DESC LIMIT 20"
);
const upsertAppointmentTracking = db.prepare(`
  INSERT INTO wa_appointment_tracking (appointment_id, patient_id, patient_name, patient_phone, appointment_date, doctor_name, service)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(appointment_id) DO UPDATE SET
    patient_name = excluded.patient_name,
    patient_phone = excluded.patient_phone,
    appointment_date = excluded.appointment_date,
    doctor_name = excluded.doctor_name,
    service = excluded.service
`);
const getUnsentConfirmations = db.prepare(
  "SELECT * FROM wa_appointment_tracking WHERE confirmation_sent = 0 AND patient_phone IS NOT NULL AND patient_phone != ''"
);
const getUnsentReminders = db.prepare(
  "SELECT * FROM wa_appointment_tracking WHERE reminder_sent = 0 AND confirmation_sent = 1 AND patient_phone IS NOT NULL AND patient_phone != ''"
);
const markConfirmationSent = db.prepare(
  "UPDATE wa_appointment_tracking SET confirmation_sent = 1, confirmation_sent_at = datetime('now') WHERE id = ?"
);
const markReminderSent = db.prepare(
  "UPDATE wa_appointment_tracking SET reminder_sent = 1, reminder_sent_at = datetime('now') WHERE id = ?"
);

// --- GPT System Prompt ---
const WEBSITE_BASE = 'https://drnakhoda.scalamatic.com';

// Map of link tags to actual URLs — the AI writes [LINK:tag] and we replace it in code
const SERVICE_LINKS = {
  'laser-hair-removal': `${WEBSITE_BASE}/services/laser-hair-removal`,
  'weightloss': `${WEBSITE_BASE}/services/weightloss-and-slimming`,
  'coolsculpting': `${WEBSITE_BASE}/services/weightloss-and-slimming#coolsculpting`,
  'emsculpt': `${WEBSITE_BASE}/services/weightloss-and-slimming#emsculpt-neo`,
  'fat-dissolving': `${WEBSITE_BASE}/services/weightloss-and-slimming#fat-dissolving`,
  'skin-rejuvenation': `${WEBSITE_BASE}/services/skin-rejuvenation`,
  'hydrafacial': `${WEBSITE_BASE}/services/skin-rejuvenation#hydrafacial`,
  'prx-t33': `${WEBSITE_BASE}/services/skin-rejuvenation#prx-t33`,
  'rf-microneedling': `${WEBSITE_BASE}/services/skin-rejuvenation#rf-microneedling`,
  'chemical-peel': `${WEBSITE_BASE}/services/skin-rejuvenation#chemical-peel`,
  'prp': `${WEBSITE_BASE}/services/skin-rejuvenation#prp`,
  'anti-aging': `${WEBSITE_BASE}/services/anti-aging-rejuvenation`,
  'botox': `${WEBSITE_BASE}/services/anti-aging-rejuvenation#botox`,
  'fillers': `${WEBSITE_BASE}/services/anti-aging-rejuvenation#dermal-fillers`,
  'thread-lift': `${WEBSITE_BASE}/services/anti-aging-rejuvenation#thread-lift`,
  'dermatology': `${WEBSITE_BASE}/services/dermatology`,
  'acne': `${WEBSITE_BASE}/services/dermatology#acne-treatment`,
  'vitiligo': `${WEBSITE_BASE}/services/dermatology#vitiligo-treatment`,
  'psoriasis': `${WEBSITE_BASE}/services/dermatology#psoriasis-treatment`,
  'hair-restoration': `${WEBSITE_BASE}/services/hair-restoration`,
  'regenera': `${WEBSITE_BASE}/services/hair-restoration#regenera-activa`,
  'hair-prp': `${WEBSITE_BASE}/services/hair-restoration#hair-prp`,
  'intimate-health': `${WEBSITE_BASE}/services/intimate-health`,
  'thermiva': `${WEBSITE_BASE}/services/intimate-health#thermiva`,
  'emsella': `${WEBSITE_BASE}/services/intimate-health#emsella`,
  'treatments': `${WEBSITE_BASE}/treatments`,
};

// All valid service URLs for matching broken/partial URLs
const ALL_SERVICE_URLS = Object.values(SERVICE_LINKS);

// Keyword to URL mapping for auto-detecting which link the AI was trying to include
const SERVICE_KEYWORDS = {
  'laser hair': 'laser-hair-removal',
  'hair removal': 'laser-hair-removal',
  'weight loss': 'weightloss',
  'slimming': 'weightloss',
  'coolsculpt': 'coolsculpting',
  'emsculpt': 'emsculpt',
  'fat dissolv': 'fat-dissolving',
  'kybella': 'fat-dissolving',
  'lemon bottle': 'fat-dissolving',
  'hydrafacial': 'hydrafacial',
  'prx-t33': 'prx-t33',
  'prx t33': 'prx-t33',
  'microneedling': 'rf-microneedling',
  'morpheus': 'rf-microneedling',
  'chemical peel': 'chemical-peel',
  'prp': 'prp',
  'platelet': 'prp',
  'botox': 'botox',
  'filler': 'fillers',
  'dermal filler': 'fillers',
  'thread lift': 'thread-lift',
  'acne': 'acne',
  'vitiligo': 'vitiligo',
  'psoriasis': 'psoriasis',
  'regenera': 'regenera',
  'hair prp': 'hair-prp',
  'hair restoration': 'hair-restoration',
  'hair loss': 'hair-restoration',
  'thermiva': 'thermiva',
  'emsella': 'emsella',
  'intimate': 'intimate-health',
  'vaginal': 'intimate-health',
  'pelvic': 'emsella',
  'skin rejuvenation': 'skin-rejuvenation',
  'anti aging': 'anti-aging',
  'anti-aging': 'anti-aging',
  'wrinkle': 'anti-aging',
  'dermatology': 'dermatology',
};

function fixReplyLinks(reply) {
  // Step 1: Replace [LINK:tag] with actual URLs
  reply = reply.replace(/\[LINK:([a-z0-9\-]+)\]/gi, (match, tag) => {
    const url = SERVICE_LINKS[tag.toLowerCase()];
    return url ? `\n\n${url}\n` : '';
  });

  // Step 2: Strip all URLs from our domain (broken, truncated, or complete)
  // We'll re-add the correct one in Step 4. NO 'i' flag so it stops at uppercase letters.
  const strippedUrls = [];
  reply = reply.replace(/https?:\/\/drnakhoda\.scalamatic\.com[a-z0-9\-\/.#]*/g, (match) => {
    strippedUrls.push(match);
    return '';
  });

  // Step 3: Determine the correct URL to use
  // First check if any stripped URL was a valid complete one
  let correctUrl = null;
  for (const url of strippedUrls) {
    if (ALL_SERVICE_URLS.includes(url)) {
      correctUrl = url;
      break;
    }
  }

  // If no valid URL was found, detect topic from keywords
  if (!correctUrl) {
    const replyLower = reply.toLowerCase();
    let bestMatch = null;
    let bestLen = 0;
    for (const [keyword, tag] of Object.entries(SERVICE_KEYWORDS)) {
      if (replyLower.includes(keyword) && keyword.length > bestLen) {
        bestMatch = tag;
        bestLen = keyword.length;
      }
    }
    if (bestMatch && SERVICE_LINKS[bestMatch]) {
      correctUrl = SERVICE_LINKS[bestMatch];
    }
  }

  // Step 4: Append the correct URL at the end, properly spaced
  if (correctUrl) {
    reply = reply.trimEnd() + '\n\n' + correctUrl;
  }

  // Step 5: Clean up extra whitespace/newlines
  reply = reply.replace(/\n{3,}/g, '\n\n').trim();

  return reply;
}

const CLINIC_SYSTEM_PROMPT = `You are the WhatsApp assistant for Dr. Nakhoda's Skin Institute, a premier dermatology and aesthetic clinic in Karachi, Pakistan.

CLINIC INFO:
- Name: Dr. Nakhoda's Skin Institute
- Lead Doctor: Dr. Tasneem Nakhoda - Board Certified Dermatologist, 20+ years experience, trained in Pakistan & USA
- Location: GPC 11, Rojhan Street, Block 5, Clifton, Karachi
- Phone: +92-300-2105374, +92-321-3822113
- Hours: 9 AM to 11 PM (call to book)
- Onsite pharmacy with skincare products

SERVICES (use the tag in square brackets when mentioning a service):
1. Laser Hair Removal [LINK:laser-hair-removal] — Permanent hair reduction using light energy for all skin types. 3-7 sessions, 80-90% reduction.
2. Weight Loss & Slimming [LINK:weightloss]
   - CoolSculpting [LINK:coolsculpting]: Non-invasive fat freezing. Up to 25% fat reduction per session.
   - Emsculpt Neo [LINK:emsculpt]: Builds muscle + reduces fat. ~25% more muscle, 30% less fat.
   - Fat Dissolving (Kybella, Lemon Bottle) [LINK:fat-dissolving]: Injections for double chin, love handles.
3. Skin Rejuvenation [LINK:skin-rejuvenation]
   - HydraFacial [LINK:hydrafacial]: Cleansing, exfoliation, hydration. Instant glow, zero downtime.
   - PRX-T33 [LINK:prx-t33]: Needle-free bio-revitalizer. Lifts and brightens skin.
   - RF Microneedling [LINK:rf-microneedling]: Deep collagen for acne scars, pores, melasma.
   - Chemical Peel [LINK:chemical-peel]: Removes damaged skin for smoother, brighter tone.
   - PRP [LINK:prp]: Your own blood platelets for skin and hair rejuvenation.
4. Anti-Aging [LINK:anti-aging]
   - Botox [LINK:botox]: Smooths wrinkles in 10-15 min, lasts 3-6 months.
   - Dermal Fillers [LINK:fillers]: Restores volume, enhances lips/cheeks. Lasts 6-18 months.
   - Thread Lift [LINK:thread-lift]: Lifts sagging skin with dissolvable threads. Lasts 1-2 years.
5. Dermatology [LINK:dermatology]
   - Acne Treatment [LINK:acne]: Medical-grade topicals, peels, laser therapy.
   - Vitiligo [LINK:vitiligo]: Phototherapy and combination therapies.
   - Psoriasis [LINK:psoriasis]: Expert management of chronic skin conditions.
6. Hair Restoration [LINK:hair-restoration]
   - Regenera Activa [LINK:regenera]: Stem cell therapy for hair regrowth.
   - Hair PRP & Exosomes [LINK:hair-prp]: Growth factors injected into scalp.
7. Intimate Health [LINK:intimate-health]
   - THERMIva [LINK:thermiva]: Non-surgical vaginal rejuvenation.
   - Emsella [LINK:emsella]: Pelvic floor strengthening chair.

RULES:
- KEEP REPLIES SHORT. Max 2-3 sentences. No bullet points or lists. Conversational tone.
- Use the same language the patient writes in (Urdu/Roman Urdu or English)
- When a patient asks about a treatment, write 1-2 sentences about it, then include the relevant [LINK:tag] on its own line. Example:

Laser hair removal permanently reduces hair growth using light energy. 3-7 sessions with 80-90% reduction!

[LINK:laser-hair-removal]

Would you like to book a consultation?

- ALWAYS put [LINK:tag] on its own separate line with a blank line before and after it. Never write a URL yourself — only use [LINK:tag] tags.
- If a patient asks generally about services, use [LINK:treatments]
- If asked about pricing, say "Prices vary by treatment. Would you like me to schedule a consultation so the doctor can assess and give you exact pricing?"
- Always try to guide toward booking an appointment
- Be warm, professional, and helpful
- If you don't know something specific, say you'll check with the doctor and get back
- For emergencies, tell them to call the clinic directly
- Never make up medical advice or diagnoses
- If someone confirms an appointment reminder, say "Great! We look forward to seeing you. If you need to reschedule, just let us know."
- Sign off messages naturally, no need for formal signatures`;

// --- Gemini Chat Function ---
async function getGPTReply(phone, incomingText, chatName) {
  if (!GROQ_API_KEY) {
    return "Thank you for your message. Our team will get back to you shortly. For immediate assistance, call us at +92-300-2105374.";
  }

  // Get conversation history for context
  const history = getConversationHistory.all(phone).reverse();

  // Build OpenAI-compatible messages array
  let systemInstruction = CLINIC_SYSTEM_PROMPT;
  if (chatName) {
    systemInstruction += `\n\nCurrent patient's WhatsApp name: ${chatName}`;
  }

  const messages = [{ role: 'system', content: systemInstruction }];

  for (const msg of history) {
    messages.push({
      role: msg.direction === 'in' ? 'user' : 'assistant',
      content: msg.message
    });
  }

  messages.push({ role: 'user', content: incomingText });

  try {
    logEvent('info', `Groq request for ${phone}`, `${messages.length} messages, last: "${incomingText.substring(0, 50)}"`);

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: messages,
        max_tokens: 350,
        temperature: 0.7
      })
    });

    const data = await response.json();

    if (!response.ok) {
      const errMsg = data.error?.message || JSON.stringify(data).substring(0, 200);
      logEvent('error', 'Groq API error', `${response.status}: ${errMsg}`);
      return `Sorry, I'm having trouble responding right now. Please call us directly at +92-300-2105374.`;
    }

    let reply = data.choices?.[0]?.message?.content?.trim();
    if (!reply) {
      logEvent('error', 'Groq empty response', JSON.stringify(data).substring(0, 200));
      return "Thank you for reaching out! Please call us at +92-300-2105374 for assistance.";
    }

    reply = fixReplyLinks(reply);

    logEvent('info', `Groq reply for ${phone}`, reply.substring(0, 80));
    return reply;
  } catch (err) {
    logEvent('error', 'Groq API error', err.message);
    return `Sorry, I'm having trouble responding right now. Please call us directly at +92-300-2105374.`;
  }
}

// --- WhatsApp API Routes (auth-protected, for dashboard) ---

// Queue a manual message from the dashboard
app.post('/api/whatsapp/send', requireAuth, (req, res) => {
  const { phone, message } = req.body;
  if (!phone || !message) return res.json({ error: 'phone and message required' });

  insertWaMessage.run(phone, null, 'out', message, 'chat', 'pending', req.session.username || null);
  logEvent('info', `WA manual message queued for ${phone} by ${req.session.username}`);
  return res.json({ ok: true });
});

// Pause/resume bot for a specific chat
app.post('/api/whatsapp/pause', requireAuth, (req, res) => {
  const { chatId } = req.body;
  if (!chatId) return res.json({ error: 'chatId required' });
  pausedChats.add(chatId);
  logEvent('info', `WA bot paused for "${chatId}" by ${req.session.username}`);
  return res.json({ ok: true, paused: true });
});

app.post('/api/whatsapp/resume', requireAuth, (req, res) => {
  const { chatId } = req.body;
  if (!chatId) return res.json({ error: 'chatId required' });
  pausedChats.delete(chatId);
  logEvent('info', `WA bot resumed for "${chatId}" by ${req.session.username}`);
  return res.json({ ok: true, paused: false });
});

app.get('/api/whatsapp/paused', requireAuth, (req, res) => {
  return res.json({ pausedChats: Array.from(pausedChats) });
});

// Get conversation history for a phone
app.get('/api/whatsapp/history/:phone', requireAuth, (req, res) => {
  const phone = decodeURIComponent(req.params.phone);
  const isAdmin = req.session.role === 'admin';
  const agent = req.session.username;
  let messages;
  if (isAdmin) {
    messages = db.prepare("SELECT * FROM wa_messages WHERE phone = ? ORDER BY created_at DESC LIMIT 50").all(phone);
  } else {
    messages = db.prepare("SELECT * FROM wa_messages WHERE phone = ? AND (agent = ?) ORDER BY created_at DESC LIMIT 50").all(phone, agent);
  }
  return res.json({ messages: messages.reverse() });
});

// Get all recent WA conversations (grouped by phone)
app.get('/api/whatsapp/conversations', requireAuth, (req, res) => {
  const isAdmin = req.session.role === 'admin';
  const agent = req.session.username;
  let conversations;
  if (isAdmin) {
    conversations = db.prepare(`
      SELECT phone, chat_name,
             MAX(created_at) as last_message_at,
             COUNT(*) as message_count,
             (SELECT message FROM wa_messages w2 WHERE w2.phone = w1.phone ORDER BY created_at DESC LIMIT 1) as last_message
      FROM wa_messages w1
      GROUP BY phone
      ORDER BY last_message_at DESC
      LIMIT 50
    `).all();
  } else {
    conversations = db.prepare(`
      SELECT phone, chat_name,
             MAX(created_at) as last_message_at,
             COUNT(*) as message_count,
             (SELECT message FROM wa_messages w2 WHERE w2.phone = w1.phone AND w2.agent = ? ORDER BY created_at DESC LIMIT 1) as last_message
      FROM wa_messages w1
      WHERE agent = ?
      GROUP BY phone
      ORDER BY last_message_at DESC
      LIMIT 50
    `).all(agent, agent);
  }
  return res.json({ conversations });
});

// Get WA bot stats
app.get('/api/whatsapp/stats', requireAuth, (req, res) => {
  const isAdmin = req.session.role === 'admin';
  const agent = req.session.username;
  let totalMessages, todayMessages, pendingMessages;
  if (isAdmin) {
    totalMessages = db.prepare("SELECT COUNT(*) as count FROM wa_messages").get().count;
    todayMessages = db.prepare("SELECT COUNT(*) as count FROM wa_messages WHERE date(created_at) = date('now')").get().count;
    pendingMessages = db.prepare("SELECT COUNT(*) as count FROM wa_messages WHERE status = 'pending'").get().count;
  } else {
    totalMessages = db.prepare("SELECT COUNT(*) as count FROM wa_messages WHERE agent = ?").get(agent).count;
    todayMessages = db.prepare("SELECT COUNT(*) as count FROM wa_messages WHERE date(created_at) = date('now') AND (agent = ?)").get(agent).count;
    pendingMessages = db.prepare("SELECT COUNT(*) as count FROM wa_messages WHERE status = 'pending' AND (agent = ?)").get(agent).count;
  }
  const totalConfirmations = db.prepare("SELECT COUNT(*) as count FROM wa_appointment_tracking WHERE confirmation_sent = 1").get().count;
  const totalReminders = db.prepare("SELECT COUNT(*) as count FROM wa_appointment_tracking WHERE reminder_sent = 1").get().count;
  const pendingConfirmations = db.prepare("SELECT COUNT(*) as count FROM wa_appointment_tracking WHERE confirmation_sent = 0 AND patient_phone IS NOT NULL AND patient_phone != ''").get().count;
  return res.json({ totalMessages, todayMessages, pendingMessages, totalConfirmations, totalReminders, pendingConfirmations });
});

// --- Appointment Scheduler ---
// Syncs appointments from Clinicea and queues confirmation + reminder messages

async function syncAppointmentsAndScheduleMessages() {
  if (!isClinicaConfigured()) return;

  try {
    // Fetch appointments for the next 7 days
    const today = new Date();
    const dates = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(today.getTime() + i * 24 * 60 * 60 * 1000);
      dates.push(d.toISOString().split('T')[0]);
    }

    for (const date of dates) {
      const data = await cliniceaFetch(`/api/v3/appointments/getAppointmentsByDate?appointmentDate=${date}&pageNo=1&pageSize=100`);
      const appointments = Array.isArray(data) ? data : [];

      for (const apt of appointments) {
        const appointmentId = String(apt.AppointmentID || apt.ID || apt.Id || '');
        if (!appointmentId) continue;

        const status = apt.AppointmentStatus || apt.Status || '';
        if (status === 'Cancelled') continue;

        const patientName = apt.AppointmentWithName || apt.PatientName ||
          [apt.PatientFirstName || apt.FirstName, apt.PatientLastName || apt.LastName].filter(Boolean).join(' ') || 'Patient';
        const patientPhone = apt.AppointmentWithPhone || apt.PatientMobile || apt.Mobile || '';
        const patientId = String(apt.PatientID || apt.patientID || '');
        const doctorName = apt.DoctorName || apt.Doctor || 'Dr. Nakhoda';
        const service = apt.ServiceName || apt.Service || '';
        const aptDate = apt.StartDateTime || apt.AppointmentDateTime || date;

        // Normalize phone
        let phone = patientPhone.replace(/[\s\-\(\)]/g, '');
        if (!phone) continue;
        if (phone.startsWith('03') && phone.length === 11) phone = '+92' + phone.substring(1);
        else if (phone.startsWith('92') && !phone.startsWith('+')) phone = '+' + phone;
        else if (!phone.startsWith('+')) phone = '+' + phone;

        // Upsert tracking record
        upsertAppointmentTracking.run(appointmentId, patientId, patientName, phone, aptDate, doctorName, service);
      }
    }

    // --- Send Confirmation Messages ---
    const unsent = getUnsentConfirmations.all();
    for (const apt of unsent) {
      const aptDate = new Date(apt.appointment_date);
      const dateStr = aptDate.toLocaleDateString('en-PK', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
      const timeStr = aptDate.toLocaleTimeString('en-PK', { hour: '2-digit', minute: '2-digit', hour12: true });

      let msg = `Assalam o Alaikum ${apt.patient_name}! Your appointment at Dr. Nakhoda's Skin Institute has been scheduled.\n\n`;
      msg += `Date: ${dateStr}\n`;
      msg += `Time: ${timeStr}\n`;
      if (apt.service) msg += `Treatment: ${apt.service}\n`;
      if (apt.doctor_name) msg += `Doctor: ${apt.doctor_name}\n`;
      msg += `\nLocation: GPC 11, Rojhan Street, Block 5, Clifton, Karachi\n`;
      msg += `\nPlease reply "CONFIRM" to confirm or call +92-300-2105374 to reschedule. We look forward to seeing you!`;

      // Queue the message
      insertWaMessage.run(apt.patient_phone, null, 'out', msg, 'confirmation', 'pending', null);
      markConfirmationSent.run(apt.id);
      logEvent('info', `WA confirmation queued for ${apt.patient_name} (${apt.patient_phone})`);
    }

    // --- Send Reminder Messages (2 days before) ---
    const reminderCandidates = getUnsentReminders.all();
    const twoDaysFromNow = new Date(today.getTime() + 2 * 24 * 60 * 60 * 1000);
    const twoDaysDate = twoDaysFromNow.toISOString().split('T')[0];

    for (const apt of reminderCandidates) {
      const aptDateStr = apt.appointment_date.split('T')[0];

      // Only send reminder if appointment is exactly 2 days away (or tomorrow/today if we missed it)
      const aptDate = new Date(aptDateStr);
      const daysUntil = Math.ceil((aptDate - today) / (24 * 60 * 60 * 1000));

      if (daysUntil <= 2 && daysUntil >= 0) {
        const dateDisplay = aptDate.toLocaleDateString('en-PK', { weekday: 'long', day: 'numeric', month: 'long' });
        const timeStr = new Date(apt.appointment_date).toLocaleTimeString('en-PK', { hour: '2-digit', minute: '2-digit', hour12: true });

        let dayWord = 'soon';
        if (daysUntil === 0) dayWord = 'today';
        else if (daysUntil === 1) dayWord = 'tomorrow';
        else if (daysUntil === 2) dayWord = 'in 2 days';

        let msg = `Reminder: Assalam o Alaikum ${apt.patient_name}! This is a friendly reminder that your appointment at Dr. Nakhoda's Skin Institute is ${dayWord}.\n\n`;
        msg += `Date: ${dateDisplay}\nTime: ${timeStr}\n`;
        if (apt.service) msg += `Treatment: ${apt.service}\n`;
        msg += `\nPlease arrive 10 minutes early. If you need to reschedule, call +92-300-2105374. See you soon!`;

        insertWaMessage.run(apt.patient_phone, null, 'out', msg, 'reminder', 'pending', null);
        markReminderSent.run(apt.id);
        logEvent('info', `WA reminder queued for ${apt.patient_name} (${apt.patient_phone}) - appointment ${dayWord}`);
      }
    }

    logEvent('info', 'Appointment sync complete');
  } catch (err) {
    logEvent('error', 'Appointment sync failed', err.message);
  }
}

// Run appointment sync every 30 minutes
setInterval(syncAppointmentsAndScheduleMessages, 30 * 60 * 1000);

// --- Socket.IO with session-based rooms ---
io.engine.use(sessionMiddleware);

io.on('connection', (socket) => {
  const session = socket.request.session;
  const username = session && session.username;
  const role = session && session.role;

  if (username) {
    // Each user joins ONLY their own agent room
    socket.join('agent:' + username);
    const rooms = ['agent:' + username];
    if (role === 'admin') {
      socket.join('role:admin');
      rooms.push('role:admin');
    }
    logEvent('info', `Socket connected: ${username} (${role}) | Rooms: ${rooms.join(', ')} | SID: ${socket.id}`);
    // Tell the client which rooms it joined — so frontend can verify
    socket.emit('join_confirm', { username, role, rooms, socketId: socket.id });
  } else {
    // Unauthenticated sockets join NO rooms — they receive nothing
    logEvent('warn', `Socket connected (unauthenticated) — no rooms joined | SID: ${socket.id}`);
    socket.emit('join_confirm', { username: null, role: null, rooms: [], socketId: socket.id, error: 'Session not found — please log in again' });
  }

  socket.on('disconnect', () => {
    logEvent('info', `Socket disconnected: ${username || 'unknown'} | SID: ${socket.id}`);
  });
});

// --- Process stability: prevent crashes from killing the server ---
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err.message, err.stack);
  try { logEvent('error', 'Uncaught exception: ' + err.message); } catch (e) {}
});
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error('[FATAL] Unhandled rejection:', msg);
  try { logEvent('error', 'Unhandled rejection: ' + msg); } catch (e) {}
});
process.on('SIGTERM', () => {
  console.log('[INFO] SIGTERM received — shutting down gracefully');
  try { logEvent('info', 'Server shutting down (SIGTERM)'); } catch (e) {}
  process.exit(0);
});

// --- Start ---
server.listen(PORT, () => {
  logEvent('info', 'Server started on port ' + PORT);
  logEvent('info', 'Clinicea API: ' + (isClinicaConfigured() ? 'Configured' : 'Not configured'));

  // Preload caches on startup so first page visits are fast
  if (isClinicaConfigured()) {
    // Preload today's appointments
    const today = new Date().toISOString().split('T')[0];
    cliniceaFetch(`/api/v3/appointments/getAppointmentsByDate?appointmentDate=${today}&pageNo=1&pageSize=100`)
      .then(data => {
        const appointments = (Array.isArray(data) ? data : []).map(mapAppointmentFields);
        appointmentDateCache.set(today, { data: appointments, expiry: Date.now() + CACHE_TTL });
        logEvent('info', `Preloaded ${appointments.length} appointments for today`);
      })
      .catch(() => {});

    // Preload patient list
    loadAllPatients().catch(() => {});

    // Initial WhatsApp appointment sync (after 10s to let caches warm up)
    setTimeout(() => syncAppointmentsAndScheduleMessages(), 10000);
  }
});
