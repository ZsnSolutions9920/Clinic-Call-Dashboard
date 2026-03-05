require('dotenv').config();
const express = require('express');
const session = require('express-session');
const http = require('http');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const DOCTOR_PHONE = process.env.DOCTOR_PHONE;
const CLINICEA_BASE_URL = process.env.CLINICEA_BASE_URL || 'https://app.clinicea.com/clinic.aspx';
const SESSION_SECRET = process.env.SESSION_SECRET;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

if (!SESSION_SECRET) {
  console.error('ERROR: SESSION_SECRET is not set in .env');
  process.exit(1);
}

// Trust Nginx proxy (needed for secure cookies behind reverse proxy)
app.set('trust proxy', 1);

// --- Hardcoded Login Credentials ---
const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD = 'clinicea2025';

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
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

const insertCall = db.prepare(
  'INSERT INTO calls (caller_number, call_sid, clinicea_url) VALUES (?, ?, ?)'
);
const PAGE_SIZE = 10;
const countCalls = db.prepare('SELECT COUNT(*) as total FROM calls');
const paginatedCalls = db.prepare(
  'SELECT * FROM calls ORDER BY timestamp DESC LIMIT ? OFFSET ?'
);

// --- Middleware ---
app.use(express.urlencoded({ extended: false })); // Twilio sends form-encoded
app.use(express.json());
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 } // 24 hours
}));

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
  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    req.session.loggedIn = true;
    return res.redirect('/');
  }
  return res.redirect('/login?error=1');
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// Webhook auth middleware
function requireWebhookSecret(req, res, next) {
  if (!WEBHOOK_SECRET) return next(); // no secret configured = no auth
  const provided = req.headers['x-webhook-secret'] || req.body.secret;
  if (provided !== WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Invalid webhook secret' });
  }
  next();
}

// Call webhook - secured with WEBHOOK_SECRET
app.post('/incoming_call', requireWebhookSecret, (req, res) => {
  const caller = req.body.From || 'Unknown';
  const callSid = req.body.CallSid || '';

  // Build Clinicea patient lookup URL
  const cliniceaUrl = `${CLINICEA_BASE_URL}?tp=pat&m=${encodeURIComponent(caller)}`;

  // Log to database
  insertCall.run(caller, callSid, cliniceaUrl);

  console.log(`[INCOMING CALL] From: ${caller} | SID: ${callSid}`);
  console.log(`[CLINICEA] ${cliniceaUrl}`);

  // Push to doctor's dashboard via WebSocket
  io.emit('incoming_call', {
    caller,
    callSid,
    cliniceaUrl,
    timestamp: new Date().toISOString()
  });

  // Respond with OK
  res.json({ status: 'ok', caller, cliniceaUrl });
});

// --- Monitor Heartbeat ---
let lastHeartbeat = 0;

app.post('/heartbeat', requireWebhookSecret, (req, res) => {
  lastHeartbeat = Date.now();
  io.emit('monitor_status', { alive: true });
  res.json({ status: 'ok' });
});

app.get('/api/monitor-status', requireAuth, (req, res) => {
  const alive = (Date.now() - lastHeartbeat) < 60000; // alive if heartbeat within 60s
  res.json({ alive });
});

// --- Download call monitor installer (pre-configured) ---
app.get('/download/call-monitor', requireAuth, (req, res) => {
  const host = req.get('host');
  const protocol = req.protocol;
  const baseUrl = `${protocol}://${host}`;
  const script = generateInstallerScript(baseUrl, WEBHOOK_SECRET);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', 'attachment; filename="install_call_monitor.ps1"');
  res.send(script);
});

function generateInstallerScript(baseUrl, secret) {
  return `<#
.SYNOPSIS
    One-click installer for Clinicea Call Monitor.
    Installs the monitor, adds it to Windows startup, and starts it immediately.
    Run this ONCE — after that it auto-starts on every login (hidden, no window).
.NOTES
    Downloaded from ${baseUrl}
#>

Write-Host ""
Write-Host "=== Clinicea Call Monitor - Installer ===" -ForegroundColor Cyan
Write-Host ""

# ── Step 1: Create install folder ──
$installDir = "$env:APPDATA\\ClinicaCallMonitor"
if (!(Test-Path $installDir)) {
    New-Item -ItemType Directory -Path $installDir -Force | Out-Null
}
Write-Host "[1/4] Install folder: $installDir" -ForegroundColor Green

# ── Step 2: Write the monitor script ──
$monitorScript = @'
$webhookUrl = "${baseUrl}/incoming_call"
$heartbeatUrl = "${baseUrl}/heartbeat"
$webhookSecret = "${secret}"

try {
    [void][Windows.UI.Notifications.Management.UserNotificationListener, Windows.UI.Notifications, ContentType = WindowsRuntime]
    [void][Windows.UI.Notifications.NotificationKinds, Windows.UI.Notifications, ContentType = WindowsRuntime]
    [void][Windows.UI.Notifications.KnownNotificationBindings, Windows.UI.Notifications, ContentType = WindowsRuntime]
    [void][Windows.UI.Notifications.UserNotification, Windows.UI.Notifications, ContentType = WindowsRuntime]
} catch {
    exit 1
}

Add-Type -AssemblyName System.Runtime.WindowsRuntime

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and
    $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation` + "`" + `1'
})[0]

function Await-AsyncOp {
    param($AsyncOp, [Type]$ResultType)
    $asTask = $script:asTaskGeneric.MakeGenericMethod($ResultType)
    $netTask = $asTask.Invoke($null, @($AsyncOp))
    $netTask.Wait(-1) | Out-Null
    return $netTask.Result
}

$listener = [Windows.UI.Notifications.Management.UserNotificationListener]::Current

try {
    $accessStatus = Await-AsyncOp ($listener.RequestAccessAsync()) ([Windows.UI.Notifications.Management.UserNotificationListenerAccessStatus])
} catch { exit 1 }

if ($accessStatus -ne [Windows.UI.Notifications.Management.UserNotificationListenerAccessStatus]::Allowed) { exit 1 }

$seenIds = @{}
$recentCalls = @{}
$lastHeartbeat = [DateTimeOffset]::Now.ToUnixTimeSeconds() - 999

while ($true) {
    try {
        $notifications = Await-AsyncOp ($listener.GetNotificationsAsync([Windows.UI.Notifications.NotificationKinds]::Toast)) ([System.Collections.Generic.IReadOnlyList[Windows.UI.Notifications.UserNotification]])

        foreach ($notif in $notifications) {
            $id = $notif.Id
            if ($seenIds.ContainsKey($id)) { continue }
            $seenIds[$id] = $true

            try { $appName = $notif.AppInfo.DisplayInfo.DisplayName } catch { continue }
            if ($appName -notmatch "Phone Link|Your Phone|Phone") { continue }

            try {
                $binding = $notif.Notification.Visual.GetBinding([Windows.UI.Notifications.KnownNotificationBindings]::ToastGeneric)
                if ($null -eq $binding) { continue }

                $textElements = $binding.GetTextElements()
                $allTexts = @()
                foreach ($elem in $textElements) { $allTexts += $elem.Text }
                $fullText = $allTexts -join " "

                if ($fullText -match "incoming|call|calling|ringing|answer|decline") {
                    $numberPart = $fullText -replace '(?i)(incoming\s*call|calling|ringing|answer|decline|voice\s*call)', ''
                    $numberPart = $numberPart.Trim()
                    $phone = $null

                    if ($numberPart -match '(\+?[\d][\d\s\-\(\)]{7,18}[\d])') {
                        $phone = $Matches[1] -replace '[\s\-\(\)]', ''
                    }

                    if ($phone) {
                        $now = [DateTimeOffset]::Now.ToUnixTimeSeconds()
                        if ($recentCalls.ContainsKey($phone) -and ($now - $recentCalls[$phone]) -lt 30) { continue }
                        $recentCalls[$phone] = $now

                        $body = "From=$([uri]::EscapeDataString($phone))&CallSid=local-$now"
                        $headers = @{ "X-Webhook-Secret" = $webhookSecret }
                        try {
                            Invoke-RestMethod -Uri $webhookUrl -Method POST -Body $body -ContentType "application/x-www-form-urlencoded" -Headers $headers -TimeoutSec 5 | Out-Null
                        } catch {}
                    }
                }
            } catch {}
        }

        if ($seenIds.Count -gt 1000) { $seenIds = @{} }
        $now = [DateTimeOffset]::Now.ToUnixTimeSeconds()
        $expiredCalls = $recentCalls.Keys | Where-Object { ($now - $recentCalls[$_]) -gt 60 }
        foreach ($key in $expiredCalls) { $recentCalls.Remove($key) }

    } catch {}

    $now = [DateTimeOffset]::Now.ToUnixTimeSeconds()
    if (($now - $lastHeartbeat) -ge 30) {
        try {
            $hbHeaders = @{ "X-Webhook-Secret" = $webhookSecret }
            Invoke-RestMethod -Uri $heartbeatUrl -Method POST -Headers $hbHeaders -TimeoutSec 5 | Out-Null
            $lastHeartbeat = $now
        } catch {}
    }

    Start-Sleep -Seconds 1
}
'@

$monitorPath = "$installDir\\call_monitor.ps1"
$monitorScript | Out-File -FilePath $monitorPath -Encoding UTF8 -Force
Write-Host "[2/4] Monitor script saved" -ForegroundColor Green

# ── Step 3: Create silent VBS launcher + add to Startup ──
$vbsContent = @"
Set objShell = CreateObject("WScript.Shell")
objShell.Run "powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -File ""$monitorPath""", 0, False
"@

$vbsPath = "$installDir\\start_monitor.vbs"
$vbsContent | Out-File -FilePath $vbsPath -Encoding ASCII -Force

$startupFolder = [Environment]::GetFolderPath('Startup')
$startupLink = "$startupFolder\\ClinicaCallMonitor.vbs"
Copy-Item -Path $vbsPath -Destination $startupLink -Force
Write-Host "[3/4] Added to Windows startup" -ForegroundColor Green

# ── Step 4: Start monitoring now ──
Start-Process -FilePath "wscript.exe" -ArgumentList """$vbsPath""" -WindowStyle Hidden
Write-Host "[4/4] Monitor started!" -ForegroundColor Green

Write-Host ""
Write-Host "Installation complete!" -ForegroundColor Cyan
Write-Host "The monitor is now running in the background and will auto-start on login." -ForegroundColor Gray
Write-Host "Dashboard: ${baseUrl}" -ForegroundColor Gray
Write-Host ""
Read-Host "Press Enter to close this window"
`;
}

// Protected dashboard - serve static files behind auth
app.get('/', requireAuth, (req, res, next) => next());
app.use(requireAuth, express.static(path.join(__dirname, 'public')));

// API - paginated call history
app.get('/api/calls', requireAuth, (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || PAGE_SIZE));
  const offset = (page - 1) * limit;
  const { total } = countCalls.get();
  const calls = paginatedCalls.all(limit, offset);
  res.json({ calls, total, page, totalPages: Math.ceil(total / limit) });
});

// --- Clinicea API Integration (Next Meeting) ---
let cliniceaToken = null;
let tokenExpiry = 0;
const meetingCache = new Map(); // phone -> { data, expiry }
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function isClinicaConfigured() {
  return CLINICEA_API_KEY && CLINICEA_API_KEY !== 'your_api_key_here' &&
         CLINICEA_STAFF_USERNAME && CLINICEA_STAFF_USERNAME !== 'your_staff_username_here' &&
         CLINICEA_STAFF_PASSWORD && CLINICEA_STAFF_PASSWORD !== 'your_staff_password_here';
}

async function cliniceaLogin() {
  const url = `${CLINICEA_API_BASE}/api/v2/login/getTokenByStaffUsernamePwd?apiKey=${encodeURIComponent(CLINICEA_API_KEY)}&loginUserName=${encodeURIComponent(CLINICEA_STAFF_USERNAME)}&pwd=${encodeURIComponent(CLINICEA_STAFF_PASSWORD)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Clinicea login failed: ${res.status}`);
  const data = await res.json();
  // Token is returned as a plain string
  cliniceaToken = typeof data === 'string' ? data : (data.Token || data.token || data.sessionId);
  tokenExpiry = Date.now() + 55 * 60 * 1000;
  console.log('[CLINICEA] Logged in successfully');
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
    console.error('[CLINICEA] Non-JSON response:', text.substring(0, 100));
    return [];
  }
}

// Find PatientID by phone number using appointment changes
async function findPatientByPhone(phone) {
  const today = new Date();
  const thirtyDaysAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
  // Use simple date format without encoding - Clinicea rejects encoded colons
  const syncDate = thirtyDaysAgo.toISOString().split('.')[0];
  const data = await cliniceaFetch(`/api/v2/appointments/getChanges?lastSyncDTime=${syncDate}&pageNo=1&pageSize=100`);
  if (!Array.isArray(data)) return null;
  // Match by phone number (try with and without +)
  const cleanPhone = phone.replace(/[\s\-]/g, '');
  const match = data.find(a =>
    a.AppointmentWithPhone === cleanPhone ||
    a.PatientMobile === cleanPhone ||
    a.AppointmentWithPhone === cleanPhone.replace('+', '') ||
    a.PatientMobile === cleanPhone.replace('+', '')
  );
  return match ? match.PatientID : null;
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
    const patientID = await findPatientByPhone(phone);

    if (!patientID) {
      const result = { nextMeeting: null };
      meetingCache.set(phone, { data: result, expiry: Date.now() + CACHE_TTL });
      return res.json(result);
    }

    const appointment = await getNextAppointmentForPatient(patientID);
    const result = { nextMeeting: appointment };
    meetingCache.set(phone, { data: result, expiry: Date.now() + CACHE_TTL });
    return res.json(result);
  } catch (err) {
    console.error('[CLINICEA API ERROR]', err.message);
    return res.json({ nextMeeting: null, error: err.message });
  }
});

// --- Socket.IO ---
io.on('connection', (socket) => {
  console.log('[DASHBOARD] Doctor connected');
  socket.on('disconnect', () => {
    console.log('[DASHBOARD] Doctor disconnected');
  });
});

// --- Start ---
server.listen(PORT, () => {
  console.log(`\n=== Call Forward Server ===`);
  console.log(`Dashboard:  http://localhost:${PORT}`);
  console.log(`Webhook:    http://localhost:${PORT}/incoming_call`);
  console.log(`Doctor:     ${DOCTOR_PHONE}`);
  console.log(`Clinicea:   ${CLINICEA_BASE_URL}`);
  console.log(`Clinicea API: ${isClinicaConfigured() ? 'Configured' : 'Not configured (set CLINICEA_API_KEY, CLINICEA_STAFF_USERNAME, CLINICEA_STAFF_PASSWORD in .env)'}`);
  console.log(`===========================\n`);
});
