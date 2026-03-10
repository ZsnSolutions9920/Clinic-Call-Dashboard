# Clinicea Call Dashboard — Complete Technical Blueprint

**System Version:** 1.0.0
**Last Updated:** 2026-03-10
**Repository:** https://github.com/ZsnSolutions9920/Clinic-Call-Dashboard
**Production URL:** https://clinicea.scalamatic.com
**VPS:** 93.127.141.213 (Ubuntu, PM2 managed)

---

## SECTION 1 — SYSTEM OVERVIEW

### 1.1 Purpose

The Clinicea Call Dashboard is an integrated CRM system for Dr. Nakhoda's Skin Institute (Karachi, Pakistan). It serves two primary functions:

1. **Incoming Call Detection & Patient Lookup** — When a patient calls the clinic's mobile phone, the system detects the call via Microsoft Phone Link on a Windows PC, extracts the caller's phone number, looks up the patient in the Clinicea EMR system, and automatically opens their profile on the agent's browser dashboard.

2. **WhatsApp AI Chatbot** — An automated WhatsApp assistant powered by Groq (Llama 3.1 8B) that responds to patient inquiries about clinic services, and sends appointment confirmation/reminder messages.

### 1.2 Major Features

| Feature | Description |
|---------|-------------|
| Call Detection | PowerShell monitor reads Windows notifications from Phone Link |
| Real-time Dashboard | Socket.IO-powered live call notifications with beep sound |
| Clinicea Integration | Patient lookup, appointment viewing, profile display via Clinicea REST API |
| Auto Profile Open | Browser automatically opens Clinicea patient profile on incoming call |
| Call History | SQLite-backed paginated call log with agent isolation |
| Appointment Calendar | Daily appointment view pulled from Clinicea API |
| Patient Directory | Cached, searchable patient list from Clinicea |
| WhatsApp Chatbot | AI-powered auto-replies via Chrome extension on web.whatsapp.com |
| Appointment Reminders | Automated confirmation + reminder messages queued via WhatsApp |
| Agent Isolation | Each agent sees only their own calls/data; admin sees everything |
| Monitor Installer | Auto-generated .bat installer per agent, downloaded from dashboard |

### 1.3 System Modules

```
┌──────────────────────────────────────────────────────────────────────┐
│                        CLINICEA CALL DASHBOARD                       │
├────────────────┬───────────────────┬───────────────────┬─────────────┤
│  Call Monitor  │  Backend Server   │  Frontend         │  WA Bot     │
│  (Windows PS1) │  (Node.js/Express)│  (HTML/JS SPA)    │  (Chrome    │
│                │                   │                   │  Extension) │
├────────────────┼───────────────────┼───────────────────┼─────────────┤
│ WinRT API      │ Express + SocketIO│ Socket.IO client  │ content.js  │
│ Notification   │ SQLite (better-   │ Call banner       │ background  │
│ Listener       │ sqlite3)          │ Call history      │ .js         │
│ Phone Link     │ Session auth      │ Patient profiles  │ popup.html  │
│ detection      │ Clinicea API      │ Calendar          │ popup.js    │
│ Heartbeat      │ Groq LLM API     │ WhatsApp panel    │             │
│ Log upload     │ PM2 managed       │ Patient search    │             │
└────────────────┴───────────────────┴───────────────────┴─────────────┘
```

### 1.4 Complete Call Flow

```
Phone receives call
        │
        ▼
Microsoft Phone Link mirrors notification to Windows desktop
        │
        ▼
PowerShell Monitor (call_monitor.ps1) running on Windows
    │
    ├─ UserNotificationListener.GetNotificationsAsync() polls every 1s
    ├─ Detects new notification from Phone Link (by app name or appId)
    ├─ Matches call keywords: "incoming", "call", "ringing", etc.
    ├─ Extracts phone number via 3-method regex extraction
    ├─ Deduplicates (30s window per number)
    │
    ▼
POST /incoming_call  (form-encoded, X-Webhook-Secret header)
    Body: From=<phone>&CallSid=local-<timestamp>&Agent=<agentName>
        │
        ▼
Server (server.js) processes the call
    │
    ├─ Validates webhook secret
    ├─ Normalizes Pakistani phone (03XX→+92XX)
    ├─ Validates agent name against USERS map
    ├─ Builds Clinicea URL: https://app.clinicea.com/clinic.aspx?tp=pat&m=<phone>
    ├─ INSERTs into calls table (SQLite)
    ├─ Emits Socket.IO 'incoming_call' event
    │   ├─ If agent known: io.to('agent:X').emit() + io.to('role:admin').emit()
    │   └─ If no agent: io.emit() (broadcast to ALL)
    ├─ Logs socket counts per target room
    │
    ├─ [ASYNC] Clinicea patient lookup
    │   ├─ findPatientByPhone() — tries v2/getPatient then appointment matching
    │   ├─ Updates DB with patient_name, patient_id
    │   └─ Emits 'patient_info' event to same rooms
    │
    ▼
Frontend Dashboard (index.html) receives Socket.IO event
    │
    ├─ socket.on('incoming_call') fires
    ├─ isEventForMe(data) checks:
    │   ├─ myUsername/myRole loaded? (reject if not)
    │   ├─ admin? → always accept
    │   ├─ data.agent matches myUsername? → accept
    │   └─ data.agent is null (untagged)? → accept
    │
    ├─ Shows yellow notification banner with caller number
    ├─ Plays beep sound (Web Audio API)
    ├─ Auto-open logic:
    │   ├─ Admin: does NOT auto-open (monitors only)
    │   ├─ Agent: auto-opens if call is theirs or untagged
    │   ├─ Uses localStorage lock to deduplicate across tabs
    │   ├─ window.open(cliniceaUrl, 'clinicea_patient')
    │   └─ If popup blocked: shows red fallback link
    │
    ├─ Refreshes call history table
    │
    ▼
Clinicea profile opens in browser tab/window
    URL: https://app.clinicea.com/clinic.aspx?tp=pat&m=+923001234567
```

### 1.5 User Roles

| Role | Username | Capabilities |
|------|----------|-------------|
| Admin | `admin` | Sees ALL calls, ALL agents' data, monitor status for all agents. Does NOT auto-open profiles. Has access to /api/socket-debug. |
| Agent | `agent1`–`agent5` | Sees only their own calls. Monitor installs for their identity. Auto-opens profiles on their calls. |

---

## SECTION 2 — FILE STRUCTURE

```
/
├── server.js                          # Main monolithic server (2030+ lines)
├── package.json                       # Node.js dependencies
├── package-lock.json                  # Lockfile
├── .env                               # Environment variables (secrets, API keys)
├── .gitignore                         # Ignores node_modules, .env, *.db
├── calls.db                           # SQLite database (auto-created, git-ignored)
├── calls.db-shm                       # SQLite shared memory (git-ignored)
├── calls.db-wal                       # SQLite WAL journal (git-ignored)
│
├── /public/
│   └── index.html                     # Single-page dashboard (HTML+CSS+JS, ~2200 lines)
│
├── /whatsapp-extension/
│   ├── manifest.json                  # Chrome Extension Manifest V3
│   ├── background.js                  # Service worker — relays messages to server
│   ├── content.js                     # Content script — runs on web.whatsapp.com
│   ├── popup.html                     # Extension popup UI
│   ├── popup.js                       # Extension popup logic
│   └── icon48.png                     # Extension icon
│
├── /.github/workflows/
│   └── deploy.yml                     # GitHub Actions CI/CD — SSH deploy to VPS
│
├── call_monitor.ps1                   # Static copy of PS1 monitor (reference only)
├── call_monitor_agent1.ps1            # Generated PS1 for agent1 (reference only)
├── Install_Call_Monitor_agent1.bat    # Generated BAT installer (reference only)
├── start_monitor.bat                  # Legacy manual starter
├── start_monitor_silent.vbs           # Legacy VBS launcher
│
├── Clinicea_Call_Dashboard_Documentation.pdf   # Previous documentation
├── WhatsApp_AI_Chatbot_Overview.pdf            # Previous documentation
└── documentation.html                          # Previous documentation (HTML)
```

### File Details

**`server.js`** (2030+ lines)
The entire backend in a single file. Contains: Express app setup, authentication, all API routes, Socket.IO integration, PowerShell monitor script generator, BAT installer generator, Clinicea API integration (login, patient search, appointments, profiles), WhatsApp bot logic (Groq API, conversation history, appointment scheduling), database schema + queries, process stability handlers.

**`public/index.html`** (~2200 lines)
The entire frontend in a single file. Contains: all CSS styles (sidebar, tables, modals, calendar, patients grid, WhatsApp panel), HTML structure (sidebar navigation, 4 page containers, notification banner, patient profile modal), all JavaScript (Socket.IO client, identity loading, event handlers, call history, calendar, patient search, WhatsApp conversations, profile modal, beep sound).

**`whatsapp-extension/`**
A Chrome Manifest V3 extension. `content.js` runs on web.whatsapp.com, scans for unread chats every 5 seconds, reads the latest message, sends it to the server via `background.js`, receives AI reply, and types+sends it back. Also polls for server-queued outgoing messages (confirmations, reminders).

**`.env`**
Contains all secrets and configuration:
- `PORT` — Server port (3000)
- `DOCTOR_PHONE` — Doctor's phone number
- `CLINICEA_BASE_URL` — Clinicea EMR web URL
- `CLINICEA_API_KEY`, `CLINICEA_STAFF_USERNAME`, `CLINICEA_STAFF_PASSWORD` — Clinicea API credentials
- `SESSION_SECRET` — Express session signing secret
- `WEBHOOK_SECRET` — Shared secret between monitor and server
- `GROQ_API_KEY` — Groq API key for Llama 3.1 8B

**`deploy.yml`**
GitHub Actions workflow: on push to `main`, SSHs into VPS, runs `git pull`, `npm install`, `pm2 restart`.

---

## SECTION 3 — BACKEND ARCHITECTURE

### 3.1 Framework & Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js |
| Framework | Express 4.21.2 |
| Realtime | Socket.IO 4.8.1 |
| Database | SQLite via better-sqlite3 11.7.0 |
| Sessions | express-session 1.19.0 (in-memory store) |
| LLM | Groq API (Llama 3.1 8B Instant) |
| Zip | archiver 7.0.1 (for WhatsApp extension download) |
| Environment | dotenv 16.4.7 |
| Process Manager | PM2 (production) |
| Reverse Proxy | Nginx (production, terminates TLS) |

### 3.2 Middleware Stack (order matters)

```
1. CORS handler          — Allows chrome-extension:// and web.whatsapp.com origins
2. express.urlencoded()  — Parses form-encoded bodies (monitor POSTs)
3. express.json()        — Parses JSON bodies
4. express-session       — Session middleware (shared with Socket.IO)
5. [Per-route] requireAuth        — Redirects to /login if no session
6. [Per-route] requireWebhookSecret — Validates X-Webhook-Secret header
7. express.static()      — Serves /public (behind requireAuth)
```

**Important:** WhatsApp API routes (`/api/whatsapp/incoming`, `/api/whatsapp/outgoing`, `/api/whatsapp/sent`) are mounted BEFORE the static middleware because they are called by the Chrome extension without authentication.

### 3.3 Authentication System

**Method:** Hardcoded username/password map with server-side sessions.

```javascript
const USERS = {
  admin:  { password: 'clinicea2025', role: 'admin' },
  agent1: { password: 'password1',    role: 'agent' },
  agent2: { password: 'password2',    role: 'agent' },
  agent3: { password: 'password3',    role: 'agent' },
  agent4: { password: 'password4',    role: 'agent' },
  agent5: { password: 'password5',    role: 'agent' },
};
```

**Login flow:**
1. `GET /login` → renders inline HTML login form
2. `POST /login` → validates credentials, sets `req.session.loggedIn`, `req.session.username`, `req.session.role`
3. Redirects to `/` on success, `/login?error=1` on failure
4. `GET /logout` → `req.session.destroy()`, redirects to `/login`

### 3.4 Session Handling

```javascript
const sessionMiddleware = session({
  secret: SESSION_SECRET,      // From .env
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 86400000 } // 24 hours
});
```

**Store:** In-memory (default MemoryStore). Sessions are LOST on server restart. This is a known limitation.

**Proxy trust:** `app.set('trust proxy', 1)` — Required because Nginx terminates TLS. Express reads `X-Forwarded-Proto` to determine the protocol.

**Socket.IO session sharing:**
```javascript
io.engine.use(sessionMiddleware);
```
This makes the Express session available on `socket.request.session` during the Socket.IO handshake. The session is read ONCE at connection time — if the session expires while the socket is connected, the socket remains in its rooms until it disconnects.

### 3.5 Server Event Log

An in-memory circular buffer of the last 50 events:

```javascript
const eventLog = []; // max 50
function logEvent(type, message, details) {
  const entry = { type, message, details, time: new Date().toISOString() };
  eventLog.push(entry);
  if (eventLog.length > MAX_LOG) eventLog.shift();
  io.emit('server_log', entry);     // Push to all connected dashboards
  console.log(/* formatted */);      // Also to PM2 logs
}
```

Every log event is broadcast to all connected sockets via `io.emit('server_log', entry)`.

### 3.6 Error Handling

```javascript
process.on('uncaughtException', (err) => { /* log, don't crash */ });
process.on('unhandledRejection', (reason) => { /* log, don't crash */ });
process.on('SIGTERM', () => { /* log, graceful exit */ });
```

The server catches all uncaught exceptions and unhandled rejections to prevent PM2 restarts. Only SIGTERM triggers a graceful exit.

---

## SECTION 4 — SOCKET.IO ARCHITECTURE

### 4.1 Room Structure

```
agent:admin    — Socket(s) for admin user
agent:agent1   — Socket(s) for agent1
agent:agent2   — Socket(s) for agent2
...
role:admin     — Socket(s) that have admin role (same sockets as agent:admin)
```

Each authenticated socket joins exactly ONE agent room: `agent:<username>`.
Admin sockets additionally join `role:admin`.
Unauthenticated sockets join NO rooms — they receive only global `io.emit()` events (server_log, wa_message).

### 4.2 Socket Authentication

On connection, the server reads the session from the HTTP upgrade handshake:

```javascript
io.on('connection', (socket) => {
  const session = socket.request.session;
  const username = session && session.username;
  const role = session && session.role;

  if (username) {
    socket.join('agent:' + username);
    if (role === 'admin') socket.join('role:admin');
    socket.emit('join_confirm', { username, role, rooms, socketId: socket.id });
  } else {
    socket.emit('join_confirm', { username: null, rooms: [], error: 'Session not found' });
  }
});
```

### 4.3 Event Catalog

#### `incoming_call` (server → client)
**Trigger:** POST /incoming_call or POST /api/test-call
**Routing:** `io.to('agent:X')` + `io.to('role:admin')` (or `io.emit()` if no agent)
**Payload:**
```json
{
  "caller": "+923001234567",
  "callSid": "local-1710000000",
  "cliniceaUrl": "https://app.clinicea.com/clinic.aspx?tp=pat&m=%2B923001234567",
  "callId": 42,
  "agent": "agent1",
  "timestamp": "2026-03-10T12:00:00.000Z"
}
```

#### `patient_info` (server → client)
**Trigger:** Async Clinicea lookup after incoming_call
**Routing:** Same as the originating incoming_call
**Payload:**
```json
{
  "caller": "+923001234567",
  "callId": 42,
  "agent": "agent1",
  "patientName": "Ahmed Khan",
  "patientID": "12345"
}
```

#### `monitor_status` (server → client)
**Trigger:** Heartbeat received or stale timer fires
**Routing:** Same as incoming_call routing by agent
**Payload:**
```json
{
  "alive": true,
  "agent": "agent1"
}
```

#### `server_log` (server → ALL clients)
**Trigger:** Every call to `logEvent()`
**Routing:** `io.emit()` (broadcast to all)
**Payload:**
```json
{
  "type": "info",
  "message": "Server started on port 3000",
  "details": null,
  "time": "2026-03-10T12:00:00.000Z"
}
```

#### `wa_message` (server → ALL clients)
**Trigger:** WhatsApp incoming message processed
**Routing:** `io.emit()` (broadcast to all)
**Payload:**
```json
{
  "phone": "+923001234567",
  "chatName": "Ahmed Khan",
  "direction": "in",
  "text": "Hello, I'd like to book an appointment",
  "reply": "Thank you for reaching out...",
  "timestamp": "2026-03-10T12:00:00.000Z"
}
```

#### `join_confirm` (server → individual socket)
**Trigger:** On socket connection
**Routing:** `socket.emit()` (only to the connecting socket)
**Payload (success):**
```json
{
  "username": "agent1",
  "role": "agent",
  "rooms": ["agent:agent1"],
  "socketId": "abc123"
}
```
**Payload (failure):**
```json
{
  "username": null,
  "role": null,
  "rooms": [],
  "socketId": "abc123",
  "error": "Session not found — please log in again"
}
```

---

## SECTION 5 — API ENDPOINT EXPORT

### 5.1 Authentication Endpoints

#### `GET /login`
- **Auth:** None
- **Response:** HTML login page
- **Query:** `?error=1` shows error message

#### `POST /login`
- **Auth:** None
- **Body:** `username=agent1&password=password1` (form-encoded)
- **Response:** 302 redirect to `/` (success) or `/login?error=1` (failure)
- **Side effect:** Sets session cookies

#### `GET /logout`
- **Auth:** Session required
- **Response:** 302 redirect to `/login`
- **Side effect:** Destroys session

#### `GET /api/me`
- **Auth:** `requireAuth`
- **Response:** `{ "username": "agent1", "role": "agent" }`

### 5.2 Call System Endpoints

#### `POST /incoming_call`
- **Auth:** `requireWebhookSecret` (X-Webhook-Secret header)
- **Body:** `From=+923001234567&CallSid=local-123&Agent=agent1` (form-encoded)
- **Response:** `{ "status": "ok", "caller": "+923001234567", "cliniceaUrl": "https://..." }`
- **Side effects:** Inserts into `calls` table, emits `incoming_call` socket event, async patient lookup

#### `POST /api/test-call`
- **Auth:** `requireAuth`
- **Body:** `{ "phone": "+920000000000" }` (JSON, optional)
- **Response:** `{ "status": "ok", "callEvent": {...} }`
- **Side effects:** Same as /incoming_call but uses session username as agent

#### `GET /api/calls`
- **Auth:** `requireAuth`
- **Query:** `?page=1&limit=10`
- **Response:**
```json
{
  "calls": [
    { "id": 1, "caller_number": "+923001234567", "call_sid": "local-123", "clinicea_url": "...", "patient_name": "Ahmed", "patient_id": "12345", "agent": "agent1", "timestamp": "2026-03-10 12:00:00" }
  ],
  "total": 42,
  "page": 1,
  "totalPages": 5
}
```
- **Isolation:** Admin sees all calls. Agents see only `WHERE agent = ?`.

### 5.3 Monitor System Endpoints

#### `POST /heartbeat`
- **Auth:** `requireWebhookSecret`
- **Body:** `Agent=agent1` (form-encoded)
- **Response:** `{ "status": "ok" }`
- **Side effects:** Updates `agentHeartbeats[agent]`, emits `monitor_status`

#### `GET /api/monitor-status`
- **Auth:** `requireAuth`
- **Response (admin):** `{ "alive": true, "agents": { "agent1": { "lastHeartbeat": 1710000000, "alive": true } } }`
- **Response (agent):** `{ "alive": true }`
- **Logic:** Uses 90s stale threshold. 2-minute startup grace period after server restart.

#### `POST /api/monitor-log`
- **Auth:** `requireWebhookSecret`
- **Body:** `Agent=agent1&Log=<last 50 lines of monitor.log>` (form-encoded)
- **Response:** `{ "status": "ok" }`
- **Storage:** In-memory `monitorLogs` map

#### `GET /api/monitor-log/:agent`
- **Auth:** `requireAuth`
- **Response:** Plain text of last uploaded log for that agent

#### `GET /api/monitor-log`
- **Auth:** `requireAuth`
- **Response:** `[{ "agent": "agent1", "lines": 50 }]`

#### `GET /api/monitor-script`
- **Auth:** `?secret=<WEBHOOK_SECRET>` query parameter
- **Query:** `?agent=agent1&secret=<secret>`
- **Response:** Raw PowerShell script text (Content-Type: text/plain)
- **Validation:** Agent must exist in USERS map

### 5.4 Download Endpoints

#### `GET /download/call-monitor`
- **Auth:** `requireAuth`
- **Response:** Agent-specific .bat installer file (Content-Disposition: attachment)
- **Agent:** Uses `req.session.username`

#### `GET /download/whatsapp-extension`
- **Auth:** `requireAuth`
- **Response:** ZIP file of whatsapp-extension directory with patched server URL
- **Patches:** `background.js` gets current server URL injected, `manifest.json` gets host_permissions added

### 5.5 Clinicea API Proxy Endpoints

#### `GET /api/next-meeting/:phone`
- **Auth:** `requireAuth`
- **Response:** `{ "nextMeeting": { "StartDateTime": "...", ... }, "patientName": "Ahmed" }`
- **Cache:** 5 minutes per phone number

#### `GET /api/patient-profile/:phone`
- **Auth:** `requireAuth`
- **Response:** `{ "patient": {...}, "appointments": [...], "bills": [...], "patientName": "...", "patientID": "..." }`
- **Cache:** 5 minutes per patient ID

#### `GET /api/patient-profile-by-id/:patientId`
- **Auth:** `requireAuth`
- **Response:** Same as above

#### `GET /api/patients`
- **Auth:** `requireAuth`
- **Query:** `?search=ahmed&page=1`
- **Response:** `{ "patients": [...], "page": 1, "hasMore": true, "total": 150 }`
- **Cache:** 10 minutes for entire patient list

#### `GET /api/appointments-by-date`
- **Auth:** `requireAuth`
- **Query:** `?date=2026-03-10&refresh=1`
- **Response:** `{ "appointments": [...], "date": "2026-03-10" }`
- **Cache:** 5 minutes per date

### 5.6 Diagnostic Endpoints

#### `GET /api/socket-debug`
- **Auth:** `requireAuth` + admin role only
- **Response:**
```json
{
  "totalSockets": 3,
  "rooms": {
    "agent:agent1": ["socketId1", "socketId2"],
    "agent:admin": ["socketId3"],
    "role:admin": ["socketId3"]
  },
  "sockets": [
    { "id": "socketId1", "username": "agent1", "role": "agent", "rooms": ["agent:agent1"] },
    { "id": "socketId3", "username": "admin", "role": "admin", "rooms": ["agent:admin", "role:admin"] }
  ]
}
```

#### `GET /api/logs`
- **Auth:** `requireAuth`
- **Response:** `{ "logs": [ { "type": "info", "message": "...", "details": "...", "time": "..." } ] }`

### 5.7 WhatsApp API Endpoints

#### `POST /api/whatsapp/incoming` (NO AUTH — called by Chrome extension)
- **Body:** `{ "messageId": "...", "text": "...", "phone": "...", "chatName": "...", "timestamp": 123 }`
- **Response:** `{ "reply": "AI response text" }` or `{ "reply": null }`
- **Side effects:** Stores message in `wa_messages`, gets Groq AI reply, stores reply, emits `wa_message` socket event

#### `GET /api/whatsapp/outgoing` (NO AUTH)
- **Response:** `{ "messages": [{ "id": 1, "phone": "+923001234567", "text": "...", "type": "reminder" }] }`

#### `POST /api/whatsapp/sent` (NO AUTH)
- **Body:** `{ "id": 1, "phone": "+923001234567", "success": true }`
- **Response:** `{ "ok": true }`

#### `POST /api/whatsapp/send`
- **Auth:** `requireAuth`
- **Body:** `{ "phone": "+923001234567", "message": "Hello..." }`
- **Response:** `{ "ok": true }`

#### `POST /api/whatsapp/pause`
- **Auth:** `requireAuth`
- **Body:** `{ "chatId": "+923001234567" }`
- **Response:** `{ "ok": true, "paused": true }`

#### `POST /api/whatsapp/resume`
- **Auth:** `requireAuth`
- **Body:** `{ "chatId": "+923001234567" }`

#### `GET /api/whatsapp/paused`
- **Auth:** `requireAuth`
- **Response:** `{ "pausedChats": ["+923001234567"] }`

#### `GET /api/whatsapp/history/:phone`
- **Auth:** `requireAuth`
- **Isolation:** Admin sees all messages for phone. Agent sees only their own.

#### `GET /api/whatsapp/conversations`
- **Auth:** `requireAuth`
- **Isolation:** Admin sees all conversations. Agent sees only their own.

#### `GET /api/whatsapp/stats`
- **Auth:** `requireAuth`
- **Response:** `{ "totalMessages": 100, "todayMessages": 5, "pendingMessages": 2, "totalConfirmations": 30, "totalReminders": 25, "pendingConfirmations": 3 }`

---

## SECTION 6 — DATABASE SCHEMA

### Database Engine
SQLite 3 via `better-sqlite3` (synchronous, WAL mode).
File: `calls.db` (auto-created in project root).

### Table: `calls`

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | Unique call ID |
| `caller_number` | TEXT NOT NULL | Normalized phone number (+92 format) |
| `call_sid` | TEXT | Call session ID (e.g., `local-1710000000` or `test-1710000000`) |
| `clinicea_url` | TEXT | Pre-built Clinicea patient lookup URL |
| `patient_name` | TEXT | Patient name (populated async after Clinicea lookup) |
| `patient_id` | TEXT | Clinicea patient ID (populated async) |
| `agent` | TEXT | Agent username who received the call (null if untagged) |
| `timestamp` | DATETIME DEFAULT CURRENT_TIMESTAMP | When the call was logged |

**Migration note:** `patient_name`, `patient_id`, and `agent` columns are added via `ALTER TABLE` with catch blocks, so they're safe on existing databases.

**Data migration:** On startup, all phone numbers matching `03XX` format (11 digits) are normalized to `+92XX` format.

### Table: `wa_messages`

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | Message ID |
| `phone` | TEXT NOT NULL | Contact phone or chat identifier |
| `chat_name` | TEXT | WhatsApp display name |
| `direction` | TEXT NOT NULL | `'in'` or `'out'` |
| `message` | TEXT NOT NULL | Message text content |
| `message_type` | TEXT DEFAULT 'chat' | `'chat'`, `'confirmation'`, or `'reminder'` |
| `status` | TEXT DEFAULT 'sent' | `'sent'`, `'pending'`, or `'failed'` |
| `agent` | TEXT | Agent who handled the message (null for bot) |
| `created_at` | DATETIME DEFAULT CURRENT_TIMESTAMP | Timestamp |

### Table: `wa_appointment_tracking`

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | Tracking ID |
| `appointment_id` | TEXT UNIQUE NOT NULL | Clinicea appointment ID |
| `patient_id` | TEXT | Clinicea patient ID |
| `patient_name` | TEXT | Patient name |
| `patient_phone` | TEXT | Normalized phone number |
| `appointment_date` | TEXT | ISO datetime of appointment |
| `doctor_name` | TEXT | Doctor name |
| `service` | TEXT | Treatment/service name |
| `confirmation_sent` | INTEGER DEFAULT 0 | 1 if confirmation message was queued |
| `reminder_sent` | INTEGER DEFAULT 0 | 1 if reminder message was queued |
| `confirmation_sent_at` | DATETIME | When confirmation was queued |
| `reminder_sent_at` | DATETIME | When reminder was queued |
| `created_at` | DATETIME DEFAULT CURRENT_TIMESTAMP | Record creation |

**UNIQUE constraint** on `appointment_id` with `ON CONFLICT DO UPDATE` — upserts on every sync.

### Prepared Statements

```
updateCallPatientName    — UPDATE calls SET patient_name = ? WHERE id = ?
updateCallPatientId      — UPDATE calls SET patient_id = ? WHERE id = ?
insertWaMessage          — INSERT INTO wa_messages (phone, chat_name, direction, message, message_type, status, agent) VALUES (...)
getPendingOutgoing       — SELECT * FROM wa_messages WHERE direction='out' AND status='pending' ORDER BY created_at ASC LIMIT 5
markMessageSent          — UPDATE wa_messages SET status='sent' WHERE id = ?
markMessageFailed        — UPDATE wa_messages SET status='failed' WHERE id = ?
getConversationHistory   — SELECT direction, message, created_at FROM wa_messages WHERE phone = ? ORDER BY created_at DESC LIMIT 20
upsertAppointmentTracking — INSERT ... ON CONFLICT(appointment_id) DO UPDATE
getUnsentConfirmations   — SELECT * FROM wa_appointment_tracking WHERE confirmation_sent = 0 AND patient_phone IS NOT NULL
getUnsentReminders       — SELECT * FROM wa_appointment_tracking WHERE reminder_sent = 0 AND confirmation_sent = 1
markConfirmationSent     — UPDATE ... SET confirmation_sent = 1, confirmation_sent_at = datetime('now') WHERE id = ?
markReminderSent         — UPDATE ... SET reminder_sent = 1, reminder_sent_at = datetime('now') WHERE id = ?
```

---

## SECTION 7 — WINDOWS CALL MONITOR SYSTEM

### 7.1 Architecture Overview

The monitor is a PowerShell 5.1+ script that uses Windows Runtime (WinRT) APIs to read system notifications. It runs as a background process on a Windows PC that is paired with the clinic's mobile phone via Microsoft Phone Link.

```
Phone Link App (Windows) ──notifications──▶ Windows Notification Center
                                                      │
                           PowerShell WinRT API ◀──────┘
                           UserNotificationListener
                                      │
                                      ▼
                             Detect call keywords
                             Extract phone number
                                      │
                                      ▼
                      POST /incoming_call ──▶ Server
                      POST /heartbeat ──▶ Server (every 30s)
                      POST /api/monitor-log ──▶ Server (every 30s)
```

### 7.2 PowerShell Script Logic (`generateMonitorScript()`)

**Initialization:**
1. Set `$ErrorActionPreference = 'Continue'` (don't stop on errors)
2. Configure variables: `$webhookUrl`, `$heartbeatUrl`, `$webhookSecret`, `$agentName`
3. Create log directory: `%APPDATA%\ClinicaCallMonitor`
4. Trim log if > 1MB
5. Validate `$agentName` is not empty
6. Send initial heartbeat BEFORE WinRT setup

**WinRT Setup (inside `Start-Monitor` function):**
1. Load WinRT assemblies:
   - `Windows.UI.Notifications.Management.UserNotificationListener`
   - `Windows.UI.Notifications.NotificationKinds`
   - `Windows.UI.Notifications.KnownNotificationBindings`
   - `Windows.UI.Notifications.UserNotification`
2. Load `System.Runtime.WindowsRuntime`
3. Find the `AsTask` generic method via reflection (needed to await WinRT async operations)
4. Get `UserNotificationListener.Current`
5. Request notification access (up to 5 attempts, 3s between)
6. If access denied, return `$false` (triggers restart loop)

**Main Loop (1-second polling):**
```
while ($true) {
    Get notifications via GetNotificationsAsync(Toast)
    For each notification:
        Skip if already seen (by notification ID)
        Get app name + appId
        Get notification text via ToastGeneric binding

        LOG every notification (diagnostic mode)

        Match phone apps:
            - By name: "phone|link|tel|call|dialer|samsung|android|mobile|microsoft"
            - By appId: "PhoneExperienceHost|YourPhone|PhoneLink|Microsoft.YourPhone"
            - WhatsApp: by name containing "whatsapp"

        Detect call:
            - Keywords in full text: "incoming|call|calling|ringing|answer|decline|dial|ring|missed"
            - Keywords in individual text parts
            - Fallback: phone number pattern in text (\+?[\d][\d\s\-\(\)]{6,18}[\d])
            - Last resort: ANY Phone Link notification = treat as call

        Extract phone number:
            Method 1: Strip keywords, find number pattern
            Method 2: Search original full text
            Method 3: Search each text part
            Fallback: Use contact name as "contact:<name>"
            Last fallback: "unknown-<timestamp>"

        Deduplicate: skip if same number within 30s

        POST /incoming_call with 3 retries (2s between)

    Clean up: reset seenIds at 1000, expire recentCalls after 60s

    Every 30s:
        POST /heartbeat with 3 retries
        POST /api/monitor-log with last 50 lines of log file

    Sleep 1 second
}
```

**Auto-Restart Loop:**
```
$maxRestarts = 20
for ($restart = 0; $restart -lt $maxRestarts; $restart++) {
    Wait (exponential backoff, max 30s)
    Send heartbeat during wait
    $result = Start-Monitor
    if ($result -eq $true) { break }
}
```

### 7.3 Installer System (`generateInstallerBat()`)

The BAT installer is generated dynamically per agent with embedded server URL and webhook secret.

**7-Step Installation Process:**

| Step | Action |
|------|--------|
| 1/7 | Stop previous monitor: end scheduled task, kill PowerShell processes running call_monitor.ps1 |
| 2/7 | Download PS1 from server: `Invoke-WebRequest` to `/api/monitor-script?agent=X&secret=Y` |
| 3/7 | Write VBS launcher: batch `echo` creates `start_monitor.vbs` |
| 4/7 | Create scheduled task: `schtasks /Create /SC ONLOGON /RL HIGHEST` (non-fatal if fails) |
| 5/7 | Copy VBS to Startup folder: fallback persistence method |
| 6/7 | Start monitor now: `start "" wscript.exe "%VBS_FILE%"` |
| 7/7 | Show completion summary and pause |

**Install locations:**
- `%APPDATA%\ClinicaCallMonitor\call_monitor.ps1` — Monitor script
- `%APPDATA%\ClinicaCallMonitor\start_monitor.vbs` — Silent launcher
- `%APPDATA%\ClinicaCallMonitor\monitor.log` — Runtime log
- `%APPDATA%\ClinicaCallMonitor\crash.log` — Crash log
- `%APPDATA%\ClinicaCallMonitor\install_<agent>.log` — Installation log
- `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\CliniceaCallMonitor_<agent>.vbs` — Startup fallback

**VBS Launcher:**
Runs PowerShell hidden (no visible window):
```vbs
Set ws = CreateObject("WScript.Shell")
appDir = ws.ExpandEnvironmentStrings("%APPDATA%") & "\ClinicaCallMonitor"
ws.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & appDir & "\call_monitor.ps1""", 0, False
```

### 7.4 Agent Identity Embedding

Each installer and script is unique per agent. The agent name is:
- Embedded in the PS1 as `$agentName = "agent1"`
- Embedded in the BAT as `set "AGENT=agent1"`
- Used in the download URL: `?agent=agent1`
- Sent with every heartbeat and webhook POST as `Agent=agent1`

This means the server always knows WHICH agent's PC detected the call.

---

## SECTION 8 — FRONTEND DASHBOARD

### 8.1 Architecture

The frontend is a single-page application in one HTML file (`public/index.html`, ~2200 lines). It uses no frontend framework — pure vanilla HTML, CSS, and JavaScript with Socket.IO client.

### 8.2 Layout Structure

```
┌─────────────────────────────────────────────────────────────┐
│ ┌──────────┐  ┌──────────────────────────────────────────┐  │
│ │ Sidebar  │  │  Page Header (title + agent badge)       │  │
│ │          │  ├──────────────────────────────────────────┤  │
│ │ Logo     │  │  Notification Banner (incoming call)     │  │
│ │          │  ├──────────────────────────────────────────┤  │
│ │ Nav:     │  │                                          │  │
│ │ Dashboard│  │  Active Page Content:                    │  │
│ │ Calendar │  │    - Dashboard: call history table       │  │
│ │ Patients │  │    - Calendar: daily appointments        │  │
│ │ WhatsApp │  │    - Patients: searchable grid           │  │
│ │          │  │    - WhatsApp: stats, conversations      │  │
│ │ ──────── │  │                                          │  │
│ │ Buttons: │  │                                          │  │
│ │ TestCall │  │                                          │  │
│ │ MonLog   │  │                                          │  │
│ │ Download │  │                                          │  │
│ │ DL WA    │  │                                          │  │
│ │          │  │                                          │  │
│ │ Status:  │  │                                          │  │
│ │ ● Server │  │                                          │  │
│ │ ● Monitor│  │                                          │  │
│ │ Agent    │  │                                          │  │
│ │ Logout   │  │                                          │  │
│ └──────────┘  └──────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### 8.3 Navigation (4 pages, SPA routing)

Pages are `<div class="page-container">` elements toggled via `display: block/none`:
- `#page-dashboard` — Call history table with pagination
- `#page-calendar` — Appointment calendar by date
- `#page-patients` — Searchable patient directory
- `#page-whatsapp` — WhatsApp bot stats, conversations, manual send

### 8.4 Sidebar Actions

| Button | Action |
|--------|--------|
| Send Test Call | `POST /api/test-call` — simulates incoming call for current user |
| View Monitor Log | Fetches `/api/monitor-log/<agent>` and shows in popup window |
| Download Monitor | Opens `/download/call-monitor` — downloads agent-specific BAT |
| Download WA Extension | Opens `/download/whatsapp-extension` — downloads patched ZIP |

### 8.5 Socket.IO Event Handling

**Connection flow:**
```javascript
const socket = io({ transports: ['websocket'] });

// Load identity
fetch('/api/me').then(r => r.json()).then(data => {
  myUsername = data.username;
  myRole = data.role;
});

// Server confirms room membership
socket.on('join_confirm', (data) => {
  if (data.error) {
    // Session expired — prompt re-login
    confirm('Your session has expired. Click OK to log in again.');
    window.location.href = '/login';
  } else {
    statusText.textContent = 'Connected (' + data.rooms.join(', ') + ')';
  }
});
```

**Ownership check (every incoming event):**
```javascript
function isEventForMe(data) {
  if (!myUsername || !myRole) return false;  // Identity not loaded
  if (myRole === 'admin') return true;       // Admin sees everything
  if (!data.agent) return true;              // Untagged = visible to all
  return data.agent === myUsername;           // Agent sees only their own
}
```

### 8.6 Auto-Open Logic

```javascript
socket.on('incoming_call', (data) => {
  if (!isEventForMe(data)) return;

  // Show banner, play beep, update history...

  // Auto-open rules:
  // Admin: NEVER auto-open (monitors only)
  // Agent: auto-open if call is tagged to them OR untagged
  const shouldAutoOpen = myRole !== 'admin' && (data.agent === myUsername || !data.agent);

  // Deduplicate across tabs
  const lockKey = 'call_opened_' + data.callId;
  if (shouldAutoOpen && !localStorage.getItem(lockKey)) {
    localStorage.setItem(lockKey, '1');
    setTimeout(() => localStorage.removeItem(lockKey), 60000);
    const win = window.open(data.cliniceaUrl, 'clinicea_patient');
    if (!win || win.closed) {
      // Popup blocked — show red fallback link
      cliniceaLink.textContent = '⚠ CLICK HERE to open patient profile (popup was blocked)';
      cliniceaLink.style.color = '#e74c3c';
    }
  }
});
```

**Popup behavior:** `window.open(url, 'clinicea_patient')` uses a named window, so subsequent calls reuse the same tab. The second argument `'clinicea_patient'` ensures only one Clinicea tab is open.

**Popup blocking:** Because the call comes from a WebSocket event (no user gesture), browsers may block `window.open()`. The user must allow popups for the dashboard domain. A red fallback link is shown if blocked.

### 8.7 Beep Sound

Generated via Web Audio API (no audio file needed):
```javascript
function playBeep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.frequency.setValueAtTime(800, ctx.currentTime);
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.5);
  } catch (e) {}
}
```

### 8.8 Patient Profile Modal

Clicking a patient row opens a modal with 3 tabs:
- **Overview**: Name, phone, email, file number, gender, registration date
- **Appointments**: Table of all appointments with status, doctor, service, date
- **Bills**: Table of all bills with amount, status, date

Data is fetched from `/api/patient-profile/:phone` or `/api/patient-profile-by-id/:id`.

---

## SECTION 9 — CALL FLOW TRACE (Detailed)

### Step 1: Phone Receives Call
Patient calls +923097480177 (doctor's phone). The phone rings normally.

### Step 2: Phone Link Generates Windows Notification
Microsoft Phone Link is paired with the phone on the clinic's Windows PC. It mirrors the incoming call notification to the Windows notification center as a toast notification. The notification contains the caller's phone number and/or contact name, and text like "Incoming call" or "Calling...".

### Step 3: Monitor Detects Notification
The PowerShell monitor (running hidden via VBS launcher) calls `UserNotificationListener.GetNotificationsAsync(Toast)` every 1 second. It receives all current toast notifications.

For each new notification (not in `$seenIds`):
- Reads `AppInfo.DisplayInfo.DisplayName` → e.g., "Phone Link"
- Reads `AppInfo.Id` → e.g., "Microsoft.YourPhone_8wekyb3d8bbwe!App"
- Reads text via `ToastGeneric` binding → e.g., "Incoming call | +92 300 123 4567"
- Logs: `NOTIF [Phone Link] id=Microsoft.YourPhone... : Incoming call | +92 300 123 4567`

### Step 4: Call Classification and Number Extraction
Monitor matches "Phone Link" against broad regex. Then finds "incoming" keyword. Then extracts phone number via regex `(\+?[\d][\d\s\-\(\)]{6,18}[\d])`.

Result: `$phone = "+923001234567"`, stripped of spaces and dashes.

Logs: `=== CALL DETECTED [Phone Link]: Incoming call | +92 300 123 4567 ===`

### Step 5: POST /incoming_call
Monitor builds form-encoded body:
```
From=%2B923001234567&CallSid=local-1710072000&Agent=agent1
```
Sends with headers:
```
Content-Type: application/x-www-form-urlencoded
X-Webhook-Secret: 4b8f2c9d1e6a3f7b8c2d5e9f1a4b6c3d
```
Retries up to 3 times with 2s delay on failure.

### Step 6: Server Processing
Server receives POST:
1. `requireWebhookSecret` validates the `X-Webhook-Secret` header
2. `normalizePKPhone("+923001234567")` → already correct format
3. Validates "agent1" exists in USERS → `agent = "agent1"`
4. Builds `cliniceaUrl = "https://app.clinicea.com/clinic.aspx?tp=pat&m=%2B923001234567"`

### Step 7: Database Record
```sql
INSERT INTO calls (caller_number, call_sid, clinicea_url, agent)
VALUES ('+923001234567', 'local-1710072000', 'https://...', 'agent1')
```
Returns `callId` (e.g., 42).

### Step 8: Socket.IO Emission
Server counts sockets in target rooms:
```
agent:agent1 room = 2 sockets (desktop + laptop)
role:admin room = 1 socket
```
Emits:
```javascript
io.to('agent:agent1').emit('incoming_call', {
  caller: '+923001234567',
  callSid: 'local-1710072000',
  cliniceaUrl: 'https://app.clinicea.com/clinic.aspx?tp=pat&m=%2B923001234567',
  callId: 42,
  agent: 'agent1',
  timestamp: '2026-03-10T12:00:00.000Z'
});
io.to('role:admin').emit('incoming_call', /* same payload */);
```

Server log: `Incoming call: +923001234567 | Agent: agent1 | Sockets: agent:agent1=2, role:admin=1`

### Step 9: Frontend Receives Event
On agent1's desktop browser:
1. `socket.on('incoming_call')` fires
2. `isEventForMe({agent: 'agent1'})` → `myRole === 'agent'` and `data.agent === 'agent1'` → **true**
3. Shows yellow notification banner: "Incoming Call — +923001234567"
4. Plays 800Hz beep for 0.5s
5. `shouldAutoOpen` = true (agent, matching call)
6. `localStorage.getItem('call_opened_42')` → null (first tab)
7. Sets lock: `localStorage.setItem('call_opened_42', '1')`
8. `window.open('https://app.clinicea.com/clinic.aspx?tp=pat&m=...', 'clinicea_patient')` opens the Clinicea profile

On admin's browser:
1. Event received via `role:admin` room
2. `isEventForMe()` → admin sees everything → **true**
3. Shows banner + beep
4. `shouldAutoOpen` = false (admin does NOT auto-open)
5. Admin must manually click the link if they want to view the profile

### Step 10: Async Patient Lookup
Meanwhile on the server:
1. `findPatientByPhone('+923001234567')` calls Clinicea API
2. Tries `v2/getPatient?searchBy=2&searchText=3001234567&searchOption=%2B92`
3. If found: updates DB with patient name and ID
4. Emits `patient_info` event to same rooms
5. Dashboard updates the banner with the patient name

---

## SECTION 10 — SECURITY MODEL

### 10.1 Authentication Layers

| Layer | Mechanism | Protects |
|-------|-----------|----------|
| Dashboard auth | Express session (cookie) | All `/api/*` routes, static files, downloads |
| Webhook auth | `X-Webhook-Secret` header | `/incoming_call`, `/heartbeat`, `/api/monitor-log` POST |
| Monitor script auth | `?secret=` query parameter | `/api/monitor-script` |
| Socket auth | Session from HTTP upgrade | Room membership (no session = no rooms) |
| Admin restriction | `req.session.role === 'admin'` | `/api/socket-debug` |

### 10.2 Secrets

| Secret | Location | Purpose |
|--------|----------|---------|
| `SESSION_SECRET` | .env | Signs session cookies |
| `WEBHOOK_SECRET` | .env | Shared secret between monitor and server |
| `CLINICEA_API_KEY` | .env | Clinicea API authentication |
| `CLINICEA_STAFF_USERNAME` | .env | Clinicea staff login |
| `CLINICEA_STAFF_PASSWORD` | .env | Clinicea staff password |
| `GROQ_API_KEY` | .env | Groq LLM API key |
| User passwords | Hardcoded in server.js | Dashboard login |

### 10.3 Known Security Risks

1. **Webhook secret in installer URL** — The BAT installer downloads the PS1 via `/api/monitor-script?secret=<WEBHOOK_SECRET>`. If the BAT file is shared or intercepted, the webhook secret is exposed. Mitigated by the fact that only authenticated users can download the installer.

2. **Hardcoded passwords** — User credentials are in server.js source code. Anyone with repo access knows all passwords. Should be moved to database or environment variables.

3. **In-memory session store** — Sessions are lost on server restart. All users are logged out. No session persistence across PM2 restarts.

4. **WhatsApp API routes are unauthenticated** — `/api/whatsapp/incoming`, `/api/whatsapp/outgoing`, `/api/whatsapp/sent` have no auth. Anyone who knows the server URL can send messages to the bot or poll for outgoing messages. Should have CORS restriction or API key.

5. **No HTTPS enforcement** — The server itself runs HTTP. HTTPS is handled by Nginx reverse proxy. If accessed directly on port 3000, traffic is unencrypted.

6. **Plaintext Clinicea credentials** — API key and staff password are in `.env` on the VPS. Access to the VPS means access to patient data.

7. **No rate limiting** — No rate limiting on any endpoint. The webhook endpoints could be spammed.

---

## SECTION 11 — DEBUGGING & DIAGNOSTICS

### 11.1 Available Diagnostic Tools

| Tool | How to Access | What It Shows |
|------|--------------|---------------|
| Server console logs | `pm2 logs clinicea-call` on VPS | Every event, API call, error |
| `/api/logs` | Dashboard (fetch via browser) | Last 50 server events |
| `/api/socket-debug` | Admin dashboard (fetch via browser) | All connected sockets, rooms, usernames |
| `join_confirm` event | Browser console | Which rooms the socket joined, or error if session invalid |
| Monitor log viewer | Sidebar → "View Monitor Log" | Last 50 lines of monitor.log from Windows PC |
| Install log | `%APPDATA%\ClinicaCallMonitor\install_<agent>.log` | BAT installer step-by-step output |
| Monitor log | `%APPDATA%\ClinicaCallMonitor\monitor.log` | Full monitor runtime log |
| Crash log | `%APPDATA%\ClinicaCallMonitor\crash.log` | WinRT failures, restart reasons |
| Browser console | F12 → Console on dashboard | Socket events, identity, room status |

### 11.2 Debugging: Monitor Not Detecting Calls

1. **Check monitor is running:** Dashboard shows "Monitor: On" (green dot). If not, check if the PS1 process is running on Windows.

2. **Check monitor log via dashboard:** Click "View Monitor Log" in sidebar. Look for:
   - `WinRT APIs loaded` — WinRT working
   - `Notification access granted` — OS permission OK
   - `NOTIF [...]` lines — Monitor IS seeing notifications
   - `PHONE APP MATCH` — Phone Link notifications detected
   - `CALL DETECTED` — Call keywords found
   - `SENDING WEBHOOK` — POST about to be sent

3. **If no NOTIF lines at all:** The WinRT `GetNotificationsAsync` is not returning notifications. Check Windows Settings → Privacy & Security → Notifications → Notification access. Ensure the script has permission.

4. **If NOTIF lines but no PHONE APP MATCH:** The notification app name/ID doesn't match the regex. Check what `appName` and `appId` values are being logged. May need to add new patterns.

5. **If PHONE APP MATCH but no CALL DETECTED:** The notification text doesn't contain expected keywords and has no phone number pattern. The notification may be in a different language or format.

6. **If CALL DETECTED but no webhook response:** Network issue. Check `Webhook FAIL` lines. Verify the server URL is reachable from the Windows PC.

### 11.3 Debugging: Socket Not Joining Rooms

1. **Check browser console:** After page load, look for:
   - `[Dashboard] Identity loaded: agent1 role: agent` — /api/me succeeded
   - `[Dashboard] Room confirm — user: agent1 role: agent rooms: agent:agent1` — Socket joined correct room

2. **If "Room confirm — error: Session not found":** The session cookie is invalid. The user needs to log in again. This happens after server restarts (in-memory session store).

3. **Check `/api/socket-debug`** (admin): Shows all connected sockets and their rooms. If a socket shows `username: null`, it has no session.

4. **Check PM2 logs:** `Socket connected (unauthenticated) — no rooms joined` means the socket's HTTP upgrade didn't carry a valid session cookie.

### 11.4 Debugging: Popup Blocking

1. **Check browser console:** Look for `[Dashboard] Auto-opening Clinicea profile...` followed by either success or `Popup blocked! Showing fallback link.`

2. **Check browser address bar:** Most browsers show a popup-blocked icon. Click it to allow popups for the site.

3. **Chrome:** Settings → Privacy and security → Site Settings → Pop-ups and redirects → Add the dashboard URL to "Allowed".

4. **If `NOT auto-opening` is logged:** Check the conditions: role, agent match, lock key. Common issue: admin role (admin is monitor-only, does NOT auto-open).

---

## SECTION 12 — CURRENT KNOWN ISSUES

### 12.1 Session Loss on Server Restart
**Problem:** In-memory session store means all sessions are lost when PM2 restarts the server. All users are logged out. All socket connections become unauthenticated.
**Impact:** Monitors continue sending heartbeats (no session needed), but dashboard users lose their socket rooms and stop receiving events until they refresh and re-login.
**Mitigation:** 2-minute startup grace period for heartbeat stale detection. `join_confirm` event prompts users to re-login.

### 12.2 Popup Blockers
**Problem:** `window.open()` from a WebSocket event handler has no user gesture, so browsers block it by default.
**Impact:** Agent's Clinicea profile doesn't auto-open on first use until they allow popups.
**Mitigation:** Red fallback link shown when popup is blocked.

### 12.3 Phone Link Notification Format Variability
**Problem:** Phone Link notification text format varies by Windows version, phone model, language, and Phone Link app version. The call keyword detection and phone number extraction regex may not match all formats.
**Impact:** Some calls may not be detected, or phone numbers may not be extracted.
**Mitigation:** Extremely broad matching with multiple fallback methods. "Last resort" treats any Phone Link notification as a call. Contact name used if no phone number found.

### 12.4 Monitor Runs as Current User Only
**Problem:** The monitor runs under the logged-in Windows user's context. If the user logs out or locks the screen, Phone Link notifications may stop. If another user logs in, they need their own monitor install.
**Impact:** Monitor goes offline when user is not logged in.

### 12.5 WhatsApp Extension DOM Fragility
**Problem:** The Chrome extension parses WhatsApp Web's DOM using CSS selectors and class names. WhatsApp frequently changes their DOM structure.
**Impact:** Extension may stop detecting unread chats or sending replies after a WhatsApp Web update.

### 12.6 Unauthenticated WhatsApp API
**Problem:** `/api/whatsapp/incoming`, `/api/whatsapp/outgoing`, `/api/whatsapp/sent` have no authentication.
**Impact:** Anyone can send fake messages to the bot or read pending outgoing messages.

### 12.7 No Persistent Monitor State
**Problem:** Heartbeat status is stored in memory (`agentHeartbeats` map). Lost on server restart.
**Impact:** After restart, all monitors show as "disconnected" until the next heartbeat arrives (up to 30s).

### 12.8 Single Database File
**Problem:** SQLite database is a single file on disk. No replication, no backups configured.
**Impact:** Data loss if disk fails. WAL mode provides crash safety but not disaster recovery.

---

## SECTION 13 — IMPROVEMENTS / FUTURE DESIGN

### 13.1 Persistent Session Store
Replace in-memory session store with Redis or SQLite-backed sessions:
```javascript
const SQLiteStore = require('connect-sqlite3')(session);
app.use(session({
  store: new SQLiteStore({ db: 'sessions.db' }),
  secret: SESSION_SECRET,
  ...
}));
```
**Benefit:** Sessions survive server restarts. No more mass logouts.

### 13.2 Windows Service / C# Monitor
Replace the PowerShell monitor with a C# .NET service:
- More reliable WinRT interop (native, not via reflection)
- Can run as a Windows Service (survives logouts)
- Proper installer via MSI or ClickOnce
- Better error handling and logging
- Could use `NotificationListener.NotificationChanged` event instead of polling

### 13.3 Secure Installer Tokens
Replace the webhook secret in installer URLs with short-lived, single-use tokens:
1. Dashboard generates a one-time token: `GET /api/installer-token` → `{ token: "abc123", expires: "..." }`
2. BAT downloads PS1 with: `/api/monitor-script?token=abc123`
3. Server validates and invalidates the token
**Benefit:** Webhook secret never leaves the server.

### 13.4 Database Backups
Add automated SQLite backups:
```javascript
setInterval(() => {
  db.backup(`calls_backup_${Date.now()}.db`);
}, 24 * 60 * 60 * 1000); // Daily
```

### 13.5 Rate Limiting
Add `express-rate-limit` to webhook and API endpoints:
```javascript
const rateLimit = require('express-rate-limit');
app.use('/incoming_call', rateLimit({ windowMs: 60000, max: 30 }));
app.use('/api/whatsapp/incoming', rateLimit({ windowMs: 60000, max: 60 }));
```

### 13.6 WhatsApp API Authentication
Add API key or HMAC authentication to WhatsApp extension routes:
```javascript
function requireExtensionAuth(req, res, next) {
  const key = req.headers['x-extension-key'];
  if (key !== process.env.EXTENSION_API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}
```

### 13.7 Call Assignment System
Currently, calls are assigned to whichever agent's monitor detects them. A call assignment/routing system could:
- Round-robin assign calls to available agents
- Allow manual transfer between agents
- Show "claimed" status in real-time
- Prevent duplicate handling

### 13.8 Centralized Logging
Replace in-memory event log with a proper logging system:
- Winston or Pino for structured logging
- Log rotation with `pm2-logrotate`
- Optional: ship logs to a central service (Datadog, Loki)

### 13.9 Notification via Alternative Methods
Instead of relying solely on `window.open()`:
- Web Push Notifications (works even when tab is not focused)
- Browser Notification API (`new Notification('Incoming Call', ...)`)
- Audio alerts with longer duration
- Desktop notification via Electron wrapper

### 13.10 Multi-Clinic Support
Current system is hardcoded for one clinic. To support multiple clinics:
- Add clinic_id to all tables
- Tenant-scoped API keys and credentials
- Per-clinic user management
- Clinic-specific WhatsApp bot personalities

---

## APPENDIX A — ENVIRONMENT VARIABLES

```env
PORT=3000                          # Server listen port
DOCTOR_PHONE=+923097480177         # Doctor's phone number (for reference)
CLINICEA_BASE_URL=https://app.clinicea.com/clinic.aspx  # Clinicea EMR web URL

# Clinicea API credentials
CLINICEA_API_KEY=<32-char hex>
CLINICEA_STAFF_USERNAME=admin@drnakhodaskinsandbox
CLINICEA_STAFF_PASSWORD=<password>

# Security secrets
SESSION_SECRET=<64-char hex>       # Express session signing
WEBHOOK_SECRET=<32-char hex>       # Monitor ↔ server shared secret

# AI API
GROQ_API_KEY=gsk_<API key>        # Groq API key for Llama 3.1 8B
```

## APPENDIX B — DEPLOYMENT

### VPS Details
- **IP:** 93.127.141.213
- **OS:** Ubuntu Linux
- **User:** administrator (sudo via password)
- **Project path:** /root/Clinic-Call-Dashboard
- **Process manager:** PM2
- **PM2 process name:** clinicea-call
- **Reverse proxy:** Nginx (terminates TLS at https://clinicea.scalamatic.com)

### Manual Deployment
```bash
ssh administrator@93.127.141.213
sudo -S bash -c 'cd /root/Clinic-Call-Dashboard && git pull origin main && npm install --production && pm2 restart clinicea-call'
```

### CI/CD (GitHub Actions)
Push to `main` triggers `.github/workflows/deploy.yml`:
1. SSH into VPS using `secrets.VPS_SSH_KEY`
2. `git pull origin main`
3. `npm install --production`
4. `pm2 restart clinicea-call`

### PM2 Commands
```bash
pm2 list                          # Show all processes
pm2 logs clinicea-call            # Tail logs
pm2 logs clinicea-call --lines 50 # Last 50 lines
pm2 restart clinicea-call         # Restart
pm2 delete clinicea-call          # Remove process
pm2 start server.js --name clinicea-call  # Create process
pm2 env 5                         # Show env vars for process ID 5
```

## APPENDIX C — CLINICEA API REFERENCE

### Authentication
```
GET /api/v2/login/getTokenByStaffUsernamePwd?apiKey=<KEY>&loginUserName=<USER>&pwd=<PASS>
Response: "<session_token_string>"
```
Token is valid for ~1 hour. Used as `api_key` query parameter on all subsequent requests.

### Patient Search
```
GET /api/v2/patients/getPatient?searchBy=2&searchText=<localNumber>&searchOption=%2B92&api_key=<TOKEN>
```
`searchBy=2` = search by mobile number. `searchOption=%2B92` = country code +92.

### Appointments
```
GET /api/v3/appointments/getAppointmentsByDate?appointmentDate=<YYYY-MM-DD>&pageNo=1&pageSize=100&api_key=<TOKEN>
GET /api/v2/appointments/getAppointmentsByPatient?patientID=<ID>&appointmentType=0&pageNo=1&pageSize=10&api_key=<TOKEN>
GET /api/v2/appointments/getChanges?lastSyncDTime=<ISO_DATE>&pageNo=1&pageSize=100&api_key=<TOKEN>
```

### Patient Details
```
GET /api/v3/patients/getPatientByID?patientID=<ID>&api_key=<TOKEN>
```

### Bills
```
GET /api/v2/bills/getBillsByPatient?patientID=<ID>&billStatus=0&pageNo=1&pageSize=50&api_key=<TOKEN>
```

### Patient List (bulk)
```
GET /api/v1/patients?lastSyncDate=2000-01-01T00:00:00&intPageNo=<PAGE>&api_key=<TOKEN>
```
Returns up to 100 patients per page.

---

*End of Technical Blueprint*
