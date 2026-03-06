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
    patient_name TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Add patient_name column if missing (existing DBs)
try { db.exec('ALTER TABLE calls ADD COLUMN patient_name TEXT'); } catch (e) { /* already exists */ }

const insertCall = db.prepare(
  'INSERT INTO calls (caller_number, call_sid, clinicea_url) VALUES (?, ?, ?)'
);
const updateCallPatientName = db.prepare(
  'UPDATE calls SET patient_name = ? WHERE id = ?'
);
const PAGE_SIZE = 10;
const countCalls = db.prepare('SELECT COUNT(*) as total FROM calls');
const paginatedCalls = db.prepare(
  'SELECT * FROM calls ORDER BY timestamp DESC LIMIT ? OFFSET ?'
);

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

  // Build Clinicea patient lookup URL
  const cliniceaUrl = `${CLINICEA_BASE_URL}?tp=pat&m=${encodeURIComponent(caller)}`;

  // Log to database
  const result = insertCall.run(caller, callSid, cliniceaUrl);
  const callId = result.lastInsertRowid;

  logEvent('info', 'Incoming call: ' + caller, 'SID: ' + callSid);

  // Push to doctor's dashboard via WebSocket
  io.emit('incoming_call', {
    caller,
    callSid,
    cliniceaUrl,
    callId,
    timestamp: new Date().toISOString()
  });

  // Async: look up patient name and push update to dashboard
  if (isClinicaConfigured()) {
    findPatientByPhone(caller).then(patient => {
      if (patient && patient.patientName) {
        updateCallPatientName.run(patient.patientName, callId);
        io.emit('patient_info', { caller, callId, patientName: patient.patientName });
        logEvent('info', 'Patient identified: ' + patient.patientName, caller);
      }
    }).catch(() => {});
  }

  // Respond with OK
  res.json({ status: 'ok', caller, cliniceaUrl });
});

// --- Monitor Heartbeat ---
let lastHeartbeat = 0;
let monitorAlive = false;

app.post('/heartbeat', requireWebhookSecret, (req, res) => {
  const wasDown = !monitorAlive;
  lastHeartbeat = Date.now();
  monitorAlive = true;
  io.emit('monitor_status', { alive: true });
  if (wasDown) logEvent('info', 'Call monitor connected (heartbeat received)');
  res.json({ status: 'ok' });
});

// Check every 15s if monitor went stale — proactively push "disconnected"
setInterval(() => {
  if (monitorAlive && (Date.now() - lastHeartbeat) > 45000) {
    monitorAlive = false;
    io.emit('monitor_status', { alive: false });
    logEvent('warn', 'Call monitor disconnected (no heartbeat for 45s)');
  }
}, 15000);

app.get('/api/monitor-status', requireAuth, (req, res) => {
  res.json({ alive: monitorAlive });
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

// --- Download Mac call monitor installer ---
app.get('/download/call-monitor-mac', requireAuth, (req, res) => {
  const host = req.get('host');
  const protocol = req.protocol;
  const baseUrl = `${protocol}://${host}`;
  const script = generateMacInstallerScript(baseUrl, WEBHOOK_SECRET);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', 'attachment; filename="install_call_monitor.sh"');
  res.send(script);
});

function generateMacInstallerScript(baseUrl, secret) {
  // Use string concatenation to avoid template literal conflicts with bash ${}
  var s = '#!/bin/bash\n';
  s += '# Clinicea Call Monitor - Mac Installer\n';
  s += '# One-click install: monitors iPhone calls via macOS Continuity\n\n';
  s += 'WEBHOOK_URL="' + baseUrl + '/incoming_call"\n';
  s += 'HEARTBEAT_URL="' + baseUrl + '/heartbeat"\n';
  s += 'WEBHOOK_SECRET="' + secret + '"\n';
  s += 'INSTALL_DIR="$HOME/.clinicea-call-monitor"\n';
  s += 'PLIST_NAME="com.clinicea.callmonitor"\n\n';
  s += 'echo ""\n';
  s += 'echo "=== Clinicea Call Monitor - Mac Installer ==="\n';
  s += 'echo ""\n\n';
  s += 'mkdir -p "$INSTALL_DIR"\n';
  s += 'echo "[1/4] Install folder: $INSTALL_DIR"\n\n';
  s += "cat > \"$INSTALL_DIR/call_monitor.sh\" << 'MONITOR_SCRIPT'\n";
  s += '#!/bin/bash\n';
  s += 'WEBHOOK_URL="PLACEHOLDER_WEBHOOK"\n';
  s += 'HEARTBEAT_URL="PLACEHOLDER_HEARTBEAT"\n';
  s += 'WEBHOOK_SECRET="PLACEHOLDER_SECRET"\n\n';
  s += 'SEEN_FILE="/tmp/clinicea_seen_calls"\n';
  s += 'HEARTBEAT_FILE="/tmp/clinicea_last_heartbeat"\n';
  s += 'touch "$SEEN_FILE"\n';
  s += 'echo "0" > "$HEARTBEAT_FILE"\n\n';
  s += 'while true; do\n';
  s += '    LOG_OUTPUT=$(log show --last 2s --predicate \'(\n';
  s += '        process == "callservicesd" AND message CONTAINS "IncomingCallRequest"\n';
  s += '    ) OR (\n';
  s += '        process == "FaceTime" AND message CONTAINS "incoming"\n';
  s += '    ) OR (\n';
  s += '        process == "CommCenter" AND message CONTAINS "IncomingCall"\n';
  s += '    ) OR (\n';
  s += '        process == "telephonyutilities" AND message CONTAINS "incoming"\n';
  s += "    )' 2>/dev/null)\n\n";
  s += '    if [ -n "$LOG_OUTPUT" ]; then\n';
  s += '        PHONES=$(echo "$LOG_OUTPUT" | grep -oE \'\\+?[0-9][0-9 \\-\\(\\)]{7,18}[0-9]\' | sed \'s/[[:space:]\\-()]//g\' | sort -u)\n';
  s += '        for PHONE in $PHONES; do\n';
  s += '            if [ ${#PHONE} -lt 7 ]; then continue; fi\n';
  s += '            NOW=$(date +%s)\n';
  s += '            if grep -q "$PHONE:$((NOW/30))" "$SEEN_FILE" 2>/dev/null; then continue; fi\n';
  s += '            echo "$PHONE:$((NOW/30))" >> "$SEEN_FILE"\n';
  s += '            curl -s -X POST "$WEBHOOK_URL" \\\n';
  s += '                -H "X-Webhook-Secret: $WEBHOOK_SECRET" \\\n';
  s += '                -H "Content-Type: application/x-www-form-urlencoded" \\\n';
  s += '                -d "From=$PHONE&CallSid=mac-$NOW" \\\n';
  s += '                --max-time 5 > /dev/null 2>&1\n';
  s += '        done\n';
  s += '    fi\n\n';
  s += '    if [ $(wc -l < "$SEEN_FILE" 2>/dev/null || echo 0) -gt 500 ]; then\n';
  s += '        tail -100 "$SEEN_FILE" > "$SEEN_FILE.tmp" && mv "$SEEN_FILE.tmp" "$SEEN_FILE"\n';
  s += '    fi\n\n';
  s += '    NOW=$(date +%s)\n';
  s += '    LAST_HB=$(cat "$HEARTBEAT_FILE" 2>/dev/null || echo "0")\n';
  s += '    if [ $((NOW - LAST_HB)) -ge 30 ]; then\n';
  s += '        curl -s -X POST "$HEARTBEAT_URL" \\\n';
  s += '            -H "X-Webhook-Secret: $WEBHOOK_SECRET" \\\n';
  s += '            --max-time 5 > /dev/null 2>&1\n';
  s += '        echo "$NOW" > "$HEARTBEAT_FILE"\n';
  s += '    fi\n\n';
  s += '    sleep 2\n';
  s += 'done\n';
  s += 'MONITOR_SCRIPT\n\n';
  s += 'sed -i \'\' "s|PLACEHOLDER_WEBHOOK|$WEBHOOK_URL|g" "$INSTALL_DIR/call_monitor.sh"\n';
  s += 'sed -i \'\' "s|PLACEHOLDER_HEARTBEAT|$HEARTBEAT_URL|g" "$INSTALL_DIR/call_monitor.sh"\n';
  s += 'sed -i \'\' "s|PLACEHOLDER_SECRET|$WEBHOOK_SECRET|g" "$INSTALL_DIR/call_monitor.sh"\n';
  s += 'chmod +x "$INSTALL_DIR/call_monitor.sh"\n';
  s += 'echo "[2/4] Monitor script saved"\n\n';
  s += 'PLIST_DIR="$HOME/Library/LaunchAgents"\n';
  s += 'mkdir -p "$PLIST_DIR"\n\n';
  s += 'cat > "$PLIST_DIR/$PLIST_NAME.plist" << PLIST_EOF\n';
  s += '<?xml version="1.0" encoding="UTF-8"?>\n';
  s += '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n';
  s += '<plist version="1.0">\n';
  s += '<dict>\n';
  s += '    <key>Label</key>\n';
  s += '    <string>com.clinicea.callmonitor</string>\n';
  s += '    <key>ProgramArguments</key>\n';
  s += '    <array>\n';
  s += '        <string>/bin/bash</string>\n';
  s += '        <string>$INSTALL_DIR/call_monitor.sh</string>\n';
  s += '    </array>\n';
  s += '    <key>RunAtLoad</key>\n';
  s += '    <true/>\n';
  s += '    <key>KeepAlive</key>\n';
  s += '    <true/>\n';
  s += '    <key>StandardOutPath</key>\n';
  s += '    <string>$INSTALL_DIR/monitor.log</string>\n';
  s += '    <key>StandardErrorPath</key>\n';
  s += '    <string>$INSTALL_DIR/monitor_error.log</string>\n';
  s += '</dict>\n';
  s += '</plist>\n';
  s += 'PLIST_EOF\n\n';
  s += 'echo "[3/4] Added to macOS LaunchAgents (auto-start on login)"\n\n';
  s += 'launchctl unload "$PLIST_DIR/$PLIST_NAME.plist" 2>/dev/null\n';
  s += 'launchctl load "$PLIST_DIR/$PLIST_NAME.plist"\n';
  s += 'echo "[4/4] Monitor started!"\n\n';
  s += 'echo ""\n';
  s += 'echo "Installation complete!"\n';
  s += 'echo "The monitor is running in the background and will auto-start on login."\n';
  s += 'echo "Dashboard: ' + baseUrl + '"\n';
  s += 'echo ""\n';
  s += 'echo "IMPORTANT: You may need to grant Terminal Full Disk Access:"\n';
  s += 'echo "  System Settings > Privacy & Security > Full Disk Access > Add Terminal"\n';
  s += 'echo ""\n';
  s += 'echo "To check logs:  tail -f ~/.clinicea-call-monitor/monitor.log"\n';
  s += 'echo "To stop:        launchctl unload ~/Library/LaunchAgents/com.clinicea.callmonitor.plist"\n';
  s += 'echo "To uninstall:   launchctl unload ~/Library/LaunchAgents/com.clinicea.callmonitor.plist && rm -rf ~/.clinicea-call-monitor ~/Library/LaunchAgents/com.clinicea.callmonitor.plist"\n';
  s += 'echo ""\n';
  return s;
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

// Find PatientID and name by phone number using appointment changes
async function findPatientByPhone(phone) {
  const today = new Date();
  const thirtyDaysAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
  // Use simple date format without encoding - Clinicea rejects encoded colons
  const syncDate = thirtyDaysAgo.toISOString().split('.')[0];
  const data = await cliniceaFetch(`/api/v2/appointments/getChanges?lastSyncDTime=${syncDate}&pageNo=1&pageSize=100`);
  if (!Array.isArray(data)) return null;
  // Normalize phone: strip spaces/dashes, build all possible variants
  const cleanPhone = phone.replace(/[\s\-\(\)]/g, '');
  // Generate all variants: +923001234567, 923001234567, 03001234567, 3001234567
  const variants = new Set();
  variants.add(cleanPhone);
  variants.add(cleanPhone.replace('+', ''));
  // If starts with 0 (local PK format like 03216315551), add 92 version
  if (cleanPhone.startsWith('0')) {
    variants.add('92' + cleanPhone.substring(1));       // 923216315551
    variants.add('+92' + cleanPhone.substring(1));      // +923216315551
  }
  // If starts with +92, add local format
  if (cleanPhone.startsWith('+92')) {
    variants.add('0' + cleanPhone.substring(3));        // 03216315551
    variants.add(cleanPhone.substring(1));              // 923216315551
  }
  // If starts with 92 (no +), add local and + format
  if (cleanPhone.startsWith('92') && !cleanPhone.startsWith('+')) {
    variants.add('+' + cleanPhone);                     // +923216315551
    variants.add('0' + cleanPhone.substring(2));        // 03216315551
  }

  logEvent('info', 'Looking up phone: ' + cleanPhone, 'Variants: ' + [...variants].join(', '));

  const match = data.find(a => {
    const apiPhone1 = (a.AppointmentWithPhone || '').replace(/[\s\-\(\)]/g, '');
    const apiPhone2 = (a.PatientMobile || '').replace(/[\s\-\(\)]/g, '');
    return variants.has(apiPhone1) || variants.has(apiPhone2);
  });

  if (!match) {
    // Log why we couldn't find a match
    const apiPhones = data.map(a => a.AppointmentWithPhone || a.PatientMobile).filter(Boolean).slice(0, 10);
    logEvent('warn', 'No patient found for ' + cleanPhone, 'API phones sample: ' + apiPhones.join(', '));
    return null;
  }

  // Log all name-related fields for debugging
  const nameFields = {};
  for (const key of Object.keys(match)) {
    if (/name|first|last|patient/i.test(key)) nameFields[key] = match[key];
  }
  logEvent('info', 'Patient match fields', JSON.stringify(nameFields));

  // Build full name from available fields
  let patientName = match.AppointmentWithName || match.PatientName || null;
  if (!patientName) {
    const first = match.PatientFirstName || match.FirstName || '';
    const last = match.PatientLastName || match.LastName || '';
    patientName = [first, last].filter(Boolean).join(' ') || null;
  }
  return { patientID: match.PatientID, patientName };
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

// API - event log history
app.get('/api/logs', requireAuth, (req, res) => {
  res.json({ logs: eventLog });
});

// --- Socket.IO ---
io.on('connection', (socket) => {
  logEvent('info', 'Dashboard client connected');
  socket.on('disconnect', () => {
    logEvent('info', 'Dashboard client disconnected');
  });
});

// --- Start ---
server.listen(PORT, () => {
  logEvent('info', 'Server started on port ' + PORT);
  logEvent('info', 'Clinicea API: ' + (isClinicaConfigured() ? 'Configured' : 'Not configured'));
});
