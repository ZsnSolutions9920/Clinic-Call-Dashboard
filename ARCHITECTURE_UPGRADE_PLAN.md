# Clinicea Call Dashboard — Architecture Review & Upgrade Plan

**Document Version:** 1.0.0
**Date:** 2026-03-10
**System:** Clinicea Call Dashboard CRM
**Repository:** https://github.com/ZsnSolutions9920/Clinic-Call-Dashboard
**Production:** https://clinicea.scalamatic.com

---

## TASK 1 — ARCHITECTURE ANALYSIS

### 1.1 Current Architecture Summary

The system is a **monolithic Node.js application** contained primarily in two files:

| File | Lines | Role |
|------|-------|------|
| `server.js` | ~2043 | Entire backend: auth, API, Socket.IO, DB, Clinicea integration, WhatsApp bot, monitor script generation, installer generation |
| `public/index.html` | ~2300 | Entire frontend: CSS, HTML, JavaScript (SPA with hash-based routing) |

Supporting files:
- `whatsapp-extension/` — Chrome extension (4 files: content.js, background.js, popup.html, popup.js)
- `.github/workflows/deploy.yml` — CI/CD (5 lines of script)
- `package.json` — 6 dependencies
- `.env` — All secrets and configuration

### 1.2 Strengths

**1. Simplicity of deployment**
The entire system is a single `node server.js` process. No build step, no bundler, no transpilation. PM2 manages the process, and deployment is `git pull && npm install && pm2 restart`. This is ideal for a small clinic team that doesn't need a DevOps engineer.

**2. Zero external service dependencies**
SQLite is embedded (no database server), sessions are in-memory (no Redis needed), and the only external APIs are Clinicea and Groq, both non-critical to core operation. The system starts instantly and works offline for call monitoring.

**3. Effective use of Socket.IO rooms**
The room architecture (`agent:<username>`, `role:admin`) cleanly isolates call events per agent. Admin sees everything, agents only see their own calls. The `join_confirm` event provides session verification. This is well-designed for the use case.

**4. Robust call monitor design**
The PowerShell monitor has: auto-restart (20 attempts with exponential backoff), heartbeat system (30s interval, 3 retries per beat), log upload for remote debugging, duplicate call suppression (30s window), crash logging, and extremely broad notification matching to maximize detection rate.

**5. Smart caching**
Clinicea API calls are cached with 5-minute TTL (appointments, meetings, profiles) and 10-minute TTL (patient list). The startup preloads today's appointments and the full patient list, so the first dashboard load is fast.

**6. Progressive enhancement**
Popup blocker detection with fallback link, session expiration detection with re-login prompt, and the admin role not auto-opening profiles are all practical solutions to real-world browser behavior.

### 1.3 Weaknesses

#### CRITICAL: Monolithic `server.js` (2043 lines)

Every concern is mixed together in one file:
- Authentication (lines 124–184)
- Call webhook handling (lines 228–299)
- Monitor heartbeat system (lines 340–411)
- Installer/script generation (lines 486–930)
- Clinicea API integration (lines 1021–1427)
- WhatsApp bot logic (lines 1434–1968)
- Socket.IO setup (lines 1973–2001)
- Process lifecycle (lines 2003–2042)

**Why this matters:** A developer cannot modify the WhatsApp bot without risk of breaking call routing. Any syntax error in the Clinicea integration section crashes the entire server. Testing individual components requires loading the whole application. New developers must read 2000+ lines to understand any single feature.

#### CRITICAL: In-Memory Session Store

```javascript
const sessionMiddleware = session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
});
```

This uses the default `MemoryStore`, which:
- **Loses all sessions on server restart** — every `pm2 restart` forces all users to re-login
- **Loses all sessions on deployment** — every git push triggers `pm2 restart clinicea-call`
- **Breaks Socket.IO room assignment** — sockets that reconnect after a restart join NO rooms because `socket.request.session.username` is `undefined`
- **Memory leak** — express-session MemoryStore does not prune expired sessions automatically, causing slow memory growth

**This is the root cause of the "laptop not opening profile" bug** — the session expired after a server restart, so the socket connected but joined no rooms, and received no call events.

#### CRITICAL: Hardcoded Credentials in Source Code

```javascript
const USERS = {
  admin: { password: 'clinicea2025', role: 'admin' },
  agent1: { password: 'password1', role: 'agent' },
  // ...
};
```

And in `.env`:
```
CLINICEA_API_KEY=XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
CLINICEA_STAFF_PASSWORD=XXXXXXXXXXXX
GROQ_API_KEY=gsk_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
```

**Why this matters:**
- Passwords are plaintext — anyone with server access can read them
- `.env` is in `.gitignore`, but the passwords in `server.js` are committed to Git
- Webhook secret is embedded in installer URLs: `?agent=agent1&secret=6e79b7723c...` — anyone who intercepts an installer download has the webhook secret
- Groq API key is committed to the repository

#### HIGH: Unauthenticated WhatsApp API Endpoints

```javascript
// These MUST be before the static middleware which requires auth
app.post('/api/whatsapp/incoming', async (req, res) => { ... });
app.get('/api/whatsapp/outgoing', (req, res) => { ... });
app.post('/api/whatsapp/sent', (req, res) => { ... });
```

These three endpoints have **zero authentication**. Anyone who knows the server URL can:
- Send fake incoming messages to trigger AI replies
- Read pending outgoing messages (which contain patient names and appointment details)
- Mark messages as sent to suppress real delivery
- Trigger unlimited Groq API calls (cost and rate limit exhaustion)

The only "protection" is the CORS middleware, which is bypassable with any HTTP client.

#### HIGH: No Rate Limiting

There is no rate limiting on any endpoint. An attacker could:
- Flood `/incoming_call` with fake calls (requires webhook secret)
- Flood `/api/whatsapp/incoming` with messages (no auth required) to exhaust Groq API credits
- Flood `/login` with brute-force attempts
- Flood any authenticated endpoint to degrade performance

#### MEDIUM: SQLite Limitations

SQLite with WAL mode handles the current load well (a small clinic with <10 agents). However:
- **No concurrent writes** — WAL mode allows concurrent reads, but writes are serialized. Under heavy load (many simultaneous incoming calls), writes will queue.
- **No network access** — the database file is local to the server. No read replicas, no multi-server deployment.
- **No built-in backup** — the `calls.db` file must be manually copied for backups. A crash during a write can corrupt the database (mitigated by WAL mode, but not eliminated).
- **Schema migrations are manual** — `ALTER TABLE ... ADD COLUMN` wrapped in try/catch. No migration tracking, no rollback capability.

#### MEDIUM: Monitor Reliability

- **Stops when user logs out of Windows** — the PowerShell process runs in user context. If the PC is locked or logged out, the monitor stops. Phone calls are missed.
- **WinRT reflection complexity** — the `AsTask` generic method resolution is fragile. Windows updates can change the reflection surface, breaking the monitor silently.
- **1-second polling loop** — the monitor polls `GetNotificationsAsync()` every second. This is CPU-wasteful and introduces up to 1 second of latency. An event-driven approach would be more efficient.
- **No update mechanism** — if the PS1 script needs updating, the user must manually re-run the BAT installer. There is no self-update or version check.

#### MEDIUM: Frontend Architecture

The entire frontend is a single 2300-line HTML file containing:
- 1596 lines of CSS
- ~700 lines of JavaScript
- ~100 lines of HTML structure

This makes it impossible to:
- Use a CSS preprocessor or component library
- Write unit tests for frontend logic
- Reuse components across pages
- Use source maps for debugging

#### LOW: Error Handling Gaps

- `cliniceaFetch()` swallows errors silently in some paths (returns `[]` instead of throwing)
- `uncaughtException` handler logs but doesn't restart — the process continues in potentially corrupted state
- `syncAppointmentsAndScheduleMessages()` catches at the top level, meaning one bad appointment stops all processing
- No request timeout on Clinicea API calls (uses default `fetch()` which can hang indefinitely)

#### LOW: Popup Blocker Behavior

`window.open()` from a WebSocket event handler has no user gesture — browsers block it by default. The current workaround (fallback link) is functional but not ideal. The fundamental issue is that the call notification arrives via WebSocket, not via user interaction, so auto-opening a new window/tab is architecturally impossible to guarantee.

### 1.4 Technical Risks

| Risk | Severity | Likelihood | Impact |
|------|----------|------------|--------|
| Server restart loses all sessions | Critical | High (every deploy) | All users disconnected, calls missed |
| WhatsApp API abuse (no auth) | High | Medium | AI cost runaway, data leak |
| Webhook secret leaked via installer URL | High | Medium | Fake calls injected |
| Monitor stops on Windows logout | Medium | High | Calls missed during off-hours |
| SQLite corruption | Low | Low | All call history lost |
| Groq API key exposed in Git | High | Already happened | Key needs rotation |

### 1.5 Performance Limitations

| Metric | Current Capacity | Bottleneck |
|--------|-----------------|------------|
| Concurrent agents | ~10 | Socket.IO memory (practical limit ~1000+ sockets) |
| Calls per minute | ~60 | SQLite write serialization |
| Patient cache | ~5000 | In-memory array, linear search |
| WhatsApp messages/min | ~12 | 5s scan interval in content script |
| Clinicea API calls | ~20/min | Token refresh + 5min cache TTL |
| Server memory | <200MB typical | MemoryStore session leak over time |

### 1.6 Security Issues Summary

1. **Plaintext passwords** in source code (committed to Git)
2. **No password hashing** — direct string comparison
3. **Unauthenticated WhatsApp endpoints** — `/api/whatsapp/incoming`, `/outgoing`, `/sent`
4. **No rate limiting** on any endpoint
5. **Webhook secret in URL** — visible in network logs, browser history, server access logs
6. **API keys in `.env`** — no encryption, no vault
7. **CORS too permissive** — allows any `chrome-extension://` origin
8. **No CSRF protection** — POST endpoints accept any origin
9. **No Content Security Policy** — XSS risk in the SPA
10. **Session fixation possible** — session ID not regenerated after login

---

## TASK 2 — RECOMMENDED ARCHITECTURE

### 2.1 Proposed Directory Structure

```
/
├── server.js                    # Entry point (15 lines — imports app.js and starts listening)
├── app.js                       # Express app setup, middleware stack, route mounting
├── package.json
├── .env
├── calls.db                     # SQLite database (auto-created)
│
├── /routes
│   ├── auth.js                  # GET/POST /login, /logout, GET /api/me
│   ├── calls.js                 # POST /incoming_call, GET /api/calls, POST /api/test-call
│   ├── monitor.js               # POST /heartbeat, GET/POST /api/monitor-log, GET /api/monitor-status, GET /api/monitor-script, GET /download/call-monitor
│   ├── clinicea.js              # GET /api/next-meeting/:phone, GET /api/patient-profile/:phone, GET /api/patient-profile-by-id/:id, GET /api/patients, GET /api/appointments-by-date
│   ├── whatsapp.js              # POST /api/whatsapp/incoming, GET /api/whatsapp/outgoing, POST /api/whatsapp/sent, POST /api/whatsapp/send, GET /api/whatsapp/conversations, etc.
│   └── admin.js                 # GET /api/socket-debug, GET /api/logs
│
├── /services
│   ├── cliniceaService.js       # Clinicea API client: login, token management, patient lookup, appointment fetch, profile fetch
│   ├── callService.js           # Call event processing: normalize phone, insert DB record, emit socket events, trigger patient lookup
│   ├── whatsappService.js       # Groq API integration, system prompt, link fixing, conversation history, appointment sync
│   ├── monitorService.js        # Heartbeat tracking, stale detection, agent heartbeat map, PS1/BAT generation
│   └── notificationService.js   # Beep/notification abstraction (if needed for future push notifications)
│
├── /socket
│   └── socketServer.js          # Socket.IO setup, session sharing, room assignment, join_confirm, disconnect logging
│
├── /db
│   ├── database.js              # SQLite connection, WAL mode, prepared statements export
│   ├── migrations.js            # Schema creation, ALTER TABLE migrations with version tracking
│   └── queries.js               # All prepared statement definitions (calls, wa_messages, wa_appointment_tracking)
│
├── /middleware
│   ├── auth.js                  # requireAuth, requireAdmin middleware
│   ├── webhookAuth.js           # requireWebhookSecret middleware
│   ├── cors.js                  # CORS configuration for Chrome extension
│   └── rateLimiter.js           # express-rate-limit configuration
│
├── /generators
│   ├── monitorScript.js         # generateMonitorScript() — PS1 generation
│   └── installerBat.js          # generateInstallerBat() — BAT generation
│
├── /config
│   ├── users.js                 # User definitions (later: database-backed)
│   ├── serviceLinks.js          # SERVICE_LINKS and SERVICE_KEYWORDS maps
│   └── constants.js             # CACHE_TTL, HEARTBEAT_STALE_MS, PAGE_SIZE, etc.
│
├── /utils
│   ├── phone.js                 # normalizePKPhone(), phone number cleaning
│   ├── logger.js                # logEvent() with event log buffer and Socket.IO broadcast
│   └── helpers.js               # Shared utility functions
│
├── /public
│   └── index.html               # Frontend (unchanged for now — refactor in Phase 2)
│
├── /whatsapp-extension
│   ├── manifest.json
│   ├── background.js
│   ├── content.js
│   ├── popup.html
│   └── popup.js
│
└── /.github
    └── /workflows
        └── deploy.yml
```

### 2.2 Module Purposes

#### Entry Points

**`server.js`** — Minimal entry point. Creates the HTTP server, attaches Socket.IO, starts listening.

```javascript
require('dotenv').config();
const { app, server } = require('./app');
const { setupSocket } = require('./socket/socketServer');
const { startSchedulers } = require('./services/whatsappService');

const PORT = process.env.PORT || 3000;
const io = setupSocket(server);

// Make io available to routes
app.set('io', io);

server.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
  startSchedulers();
});
```

**`app.js`** — Express application setup. Mounts all middleware and routes.

```javascript
const express = require('express');
const http = require('http');
const session = require('express-session');
const { corsMiddleware } = require('./middleware/cors');
const { sessionMiddleware } = require('./middleware/auth');
const { rateLimiter } = require('./middleware/rateLimiter');

const app = express();
const server = http.createServer(app);

// Middleware stack
app.set('trust proxy', 1);
app.use(corsMiddleware);
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(sessionMiddleware);
app.use(rateLimiter);

// Public routes (no auth)
app.use('/', require('./routes/auth'));

// WhatsApp extension routes (extension auth, before static)
app.use('/api/whatsapp', require('./routes/whatsapp'));

// Webhook routes (webhook secret auth)
app.use('/', require('./routes/calls'));
app.use('/', require('./routes/monitor'));

// Protected routes (session auth)
app.use('/', require('./routes/clinicea'));
app.use('/', require('./routes/admin'));

// Static files (behind auth)
const { requireAuth } = require('./middleware/auth');
app.get('/', requireAuth, (req, res, next) => next());
app.use(requireAuth, express.static('public'));

module.exports = { app, server, sessionMiddleware };
```

#### Routes

**`routes/auth.js`** — Login page rendering, POST login handler, logout, GET /api/me. Extracted from server.js lines 124–184. Approximately 60 lines.

**`routes/calls.js`** — POST /incoming_call (the main webhook), POST /api/test-call, GET /api/calls. This is the core call handling logic. Uses `callService.js` for processing. Approximately 80 lines.

**`routes/monitor.js`** — POST /heartbeat, monitor log upload/retrieval, GET /api/monitor-status, GET /api/monitor-script, GET /download/call-monitor. Uses `monitorService.js` for heartbeat tracking and `generators/` for script generation. Approximately 100 lines.

**`routes/clinicea.js`** — All Clinicea-related API endpoints: patient lookup, profile, appointments by date, patient list. Uses `cliniceaService.js`. Approximately 120 lines.

**`routes/whatsapp.js`** — All WhatsApp endpoints (both public extension endpoints and protected dashboard endpoints). Uses `whatsappService.js`. Approximately 100 lines.

**`routes/admin.js`** — GET /api/socket-debug, GET /api/logs. Admin-only endpoints. Approximately 30 lines.

#### Services

**`services/cliniceaService.js`** — Clinicea API client. Manages: API token lifecycle (login, refresh, retry on 401), patient search (v2/getPatient, appointment-based fallback), profile fetching (parallel details/appointments/bills), appointment queries. All caching logic lives here (meetingCache, appointmentDateCache, profileCache, patientCache). Approximately 300 lines.

**`services/callService.js`** — Call event processing pipeline. Takes a raw incoming call request, normalizes the phone number, inserts the DB record, constructs the call event, routes it to the correct Socket.IO rooms, and triggers async patient lookup. This is the critical path. Approximately 60 lines.

**`services/whatsappService.js`** — Groq API integration. Contains: system prompt, getGPTReply(), fixReplyLinks(), conversation history retrieval, appointment sync scheduler (syncAppointmentsAndScheduleMessages), confirmation/reminder message generation. Approximately 350 lines.

**`services/monitorService.js`** — Agent heartbeat tracking. Contains: agentHeartbeats map, stale detection interval, heartbeat processing logic. Approximately 80 lines.

#### Database

**`db/database.js`** — Creates the SQLite connection, enables WAL mode, exports the `db` instance.

```javascript
const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '..', 'calls.db'));
db.pragma('journal_mode = WAL');

module.exports = db;
```

**`db/migrations.js`** — Schema creation and migrations. Runs on startup. Tracks migration version in a `_migrations` table.

```javascript
const db = require('./database');

function runMigrations() {
  // Create migrations tracking table
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  const applied = new Set(
    db.prepare('SELECT name FROM _migrations').all().map(r => r.name)
  );

  const migrations = [
    {
      name: '001_create_calls',
      sql: `CREATE TABLE IF NOT EXISTS calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        caller_number TEXT NOT NULL,
        call_sid TEXT,
        clinicea_url TEXT,
        patient_name TEXT,
        patient_id TEXT,
        agent TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      )`
    },
    {
      name: '002_create_wa_messages',
      sql: `CREATE TABLE IF NOT EXISTS wa_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        phone TEXT NOT NULL,
        chat_name TEXT,
        direction TEXT NOT NULL,
        message TEXT NOT NULL,
        message_type TEXT DEFAULT 'chat',
        status TEXT DEFAULT 'sent',
        agent TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`
    },
    {
      name: '003_create_wa_appointment_tracking',
      sql: `CREATE TABLE IF NOT EXISTS wa_appointment_tracking (
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
      )`
    },
    {
      name: '004_normalize_phone_numbers',
      sql: null, // Handled programmatically
      fn: () => {
        const rows = db.prepare("SELECT id, caller_number FROM calls WHERE caller_number LIKE '03%' AND length(caller_number) = 11").all();
        const update = db.prepare('UPDATE calls SET caller_number = ? WHERE id = ?');
        const tx = db.transaction(() => {
          for (const row of rows) {
            update.run('+92' + row.caller_number.substring(1), row.id);
          }
        });
        tx();
        if (rows.length > 0) console.log(`[MIGRATION] Normalized ${rows.length} phone numbers`);
      }
    }
  ];

  for (const m of migrations) {
    if (applied.has(m.name)) continue;
    if (m.sql) db.exec(m.sql);
    if (m.fn) m.fn();
    db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(m.name);
    console.log(`[MIGRATION] Applied: ${m.name}`);
  }
}

module.exports = { runMigrations };
```

**`db/queries.js`** — All prepared statements in one place.

```javascript
const db = require('./database');

module.exports = {
  insertCall: db.prepare('INSERT INTO calls (caller_number, call_sid, clinicea_url, agent) VALUES (?, ?, ?, ?)'),
  updateCallPatientName: db.prepare('UPDATE calls SET patient_name = ? WHERE id = ?'),
  updateCallPatientId: db.prepare('UPDATE calls SET patient_id = ? WHERE id = ?'),
  getCallsAdmin: db.prepare('SELECT * FROM calls ORDER BY timestamp DESC LIMIT ? OFFSET ?'),
  getCallsAgent: db.prepare('SELECT * FROM calls WHERE agent = ? ORDER BY timestamp DESC LIMIT ? OFFSET ?'),
  countCallsAdmin: db.prepare('SELECT COUNT(*) as total FROM calls'),
  countCallsAgent: db.prepare('SELECT COUNT(*) as total FROM calls WHERE agent = ?'),
  insertWaMessage: db.prepare('INSERT INTO wa_messages (phone, chat_name, direction, message, message_type, status, agent) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  getPendingOutgoing: db.prepare("SELECT * FROM wa_messages WHERE direction = 'out' AND status = 'pending' ORDER BY created_at ASC LIMIT 5"),
  markMessageSent: db.prepare("UPDATE wa_messages SET status = 'sent' WHERE id = ?"),
  markMessageFailed: db.prepare("UPDATE wa_messages SET status = 'failed' WHERE id = ?"),
  getConversationHistory: db.prepare("SELECT direction, message, created_at FROM wa_messages WHERE phone = ? ORDER BY created_at DESC LIMIT 20"),
  // ... all other prepared statements
};
```

#### Middleware

**`middleware/auth.js`** — Session middleware configuration, `requireAuth`, `requireAdmin` functions. Exports `sessionMiddleware` for Socket.IO sharing.

**`middleware/webhookAuth.js`** — `requireWebhookSecret` middleware. Validates `X-Webhook-Secret` header or `secret` body parameter.

**`middleware/cors.js`** — CORS configuration for Chrome extension origins.

**`middleware/rateLimiter.js`** — Rate limiting configuration (see Task 4).

#### Generators

**`generators/monitorScript.js`** — `generateMonitorScript(baseUrl, secret, agent)`. The entire PS1 template string. ~330 lines. No other logic, just the template.

**`generators/installerBat.js`** — `generateInstallerBat(baseUrl, secret, agent)`. The entire BAT template. ~110 lines. No other logic.

These are the longest individual modules, but they are pure string generation with no side effects, making them easy to test and modify independently.

### 2.3 Migration Path

The refactoring can be done incrementally:

1. **Phase 1 — Extract config and utilities** (~30 minutes)
   Move `USERS`, `SERVICE_LINKS`, constants, `normalizePKPhone()`, `logEvent()` to their own files. `server.js` imports them. Zero behavior change.

2. **Phase 2 — Extract database** (~30 minutes)
   Move SQLite setup, migrations, and prepared statements to `/db/`. `server.js` imports `db` and queries. Zero behavior change.

3. **Phase 3 — Extract generators** (~15 minutes)
   Move `generateMonitorScript()` and `generateInstallerBat()` to `/generators/`. These are pure functions with no dependencies.

4. **Phase 4 — Extract services** (~1 hour)
   Move Clinicea API logic to `cliniceaService.js`, WhatsApp/Groq logic to `whatsappService.js`, heartbeat logic to `monitorService.js`. These require passing `io` (Socket.IO instance) as a parameter or using `app.get('io')`.

5. **Phase 5 — Extract routes** (~1 hour)
   Convert each endpoint group to an Express Router in `/routes/`. Mount them in `app.js`.

6. **Phase 6 — Extract Socket.IO** (~30 minutes)
   Move the `io.on('connection', ...)` handler to `/socket/socketServer.js`.

7. **Phase 7 — Create new entry point** (~15 minutes)
   Create `app.js` and slim `server.js` down to the entry point.

**Total estimated effort: ~4 hours of careful refactoring.**

---

## TASK 3 — SESSION IMPROVEMENTS

### 3.1 Why MemoryStore is Unsafe

The current session configuration:

```javascript
const sessionMiddleware = session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
});
```

The `express-session` default MemoryStore has these problems:

1. **Data loss on restart**: Every `pm2 restart` (including deployments) destroys all sessions. Users must log in again. More critically, Socket.IO connections that reconnect after a restart have no valid session — they join no rooms and receive no call events. This is the root cause of the "laptop doesn't open profile" bug.

2. **Memory leak**: The MemoryStore never prunes expired sessions. Over time, memory usage grows unbounded. The express-session README explicitly warns: *"The default server-side session storage, MemoryStore, is purposely not designed for a production environment."*

3. **No horizontal scaling**: If you ever need two server instances (e.g., behind a load balancer), sessions are not shared. A request hitting instance A cannot read a session created on instance B.

4. **No session visibility**: There's no way to list active sessions, force-logout a user, or audit who is logged in (except via `/api/socket-debug` which shows sockets, not sessions).

### 3.2 Option A: SQLite Session Store (Recommended for this system)

Since the system already uses SQLite, using a SQLite-backed session store adds zero new infrastructure dependencies.

**Implementation:**

```bash
npm install better-sqlite3-session-store
```

```javascript
// middleware/auth.js
const session = require('express-session');
const SqliteStore = require('better-sqlite3-session-store')(session);
const Database = require('better-sqlite3');

const sessionDb = new Database('sessions.db');

const sessionMiddleware = session({
  store: new SqliteStore({
    client: sessionDb,
    expired: {
      clear: true,           // Auto-delete expired sessions
      intervalMs: 900000     // Check every 15 minutes
    }
  }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000,  // 7 days (sessions survive restarts now)
    httpOnly: true,
    sameSite: 'lax'
  }
});
```

**Benefits:**
- Sessions survive server restarts and deployments
- Expired sessions are automatically cleaned up
- No additional infrastructure (Redis, etc.)
- Session data is inspectable via SQLite queries
- Users stay logged in across deployments
- Socket.IO reconnections find valid sessions immediately

**Why not Redis (Option B)?**
Redis is superior for high-scale systems, but this is a single-server clinic application with <10 concurrent users. Adding Redis introduces: a new process to manage (PM2 or systemd), a new port to secure, a new dependency that can fail independently, and operational complexity for a non-technical team. SQLite sessions are the right choice for this scale.

### 3.3 Session Regeneration After Login

Add session regeneration to prevent session fixation:

```javascript
app.post('/login', (req, res) => {
  const { username, password } = req.body;
  const user = USERS[username];
  if (user && user.password === password) {
    // Regenerate session ID to prevent fixation
    req.session.regenerate((err) => {
      if (err) return res.redirect('/login?error=1');
      req.session.loggedIn = true;
      req.session.username = username;
      req.session.role = user.role;
      req.session.save((err) => {
        if (err) return res.redirect('/login?error=1');
        return res.redirect('/');
      });
    });
    return;
  }
  return res.redirect('/login?error=1');
});
```

---

## TASK 4 — SECURITY IMPROVEMENTS

### 4.1 Issue 1: Hardcoded Plaintext Passwords

**Current state:**
```javascript
const USERS = {
  admin: { password: 'clinicea2025', role: 'admin' },
  agent1: { password: 'password1', role: 'agent' },
};
```

**Fix: bcrypt password hashing**

```bash
npm install bcrypt
```

```javascript
// config/users.js
const bcrypt = require('bcrypt');

// Pre-hashed passwords (generated with bcrypt.hashSync('password', 12))
const USERS = {
  admin: {
    passwordHash: '$2b$12$...',  // bcrypt hash of actual password
    role: 'admin'
  },
  agent1: {
    passwordHash: '$2b$12$...',
    role: 'agent'
  },
};

async function verifyPassword(username, password) {
  const user = USERS[username];
  if (!user) return null;
  const match = await bcrypt.compare(password, user.passwordHash);
  return match ? user : null;
}

module.exports = { USERS, verifyPassword };
```

**Login handler:**
```javascript
app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const user = await verifyPassword(username, password);
  if (user) {
    req.session.regenerate((err) => {
      if (err) return res.redirect('/login?error=1');
      req.session.loggedIn = true;
      req.session.username = username;
      req.session.role = user.role;
      req.session.save(() => res.redirect('/'));
    });
    return;
  }
  return res.redirect('/login?error=1');
});
```

**Password hash generation script:**
```javascript
// scripts/hash-password.js
const bcrypt = require('bcrypt');
const password = process.argv[2];
if (!password) { console.log('Usage: node hash-password.js <password>'); process.exit(1); }
console.log(bcrypt.hashSync(password, 12));
```

### 4.2 Issue 2: Webhook Secret in Installer URL

**Current state:**
The BAT installer downloads the PS1 script from:
```
%SERVER_URL%/api/monitor-script?agent=agent1&secret=6e79b7723c...
```

The webhook secret is visible in:
- The BAT file itself (saved to disk)
- Browser download history
- Network logs on the server

**Fix: One-time installer tokens**

Instead of using the actual webhook secret, generate a short-lived download token:

```javascript
// services/monitorService.js
const crypto = require('crypto');
const installerTokens = new Map(); // token -> { agent, createdAt }

function generateInstallerToken(agent) {
  const token = crypto.randomBytes(32).toString('hex');
  installerTokens.set(token, { agent, createdAt: Date.now() });
  // Expire after 10 minutes
  setTimeout(() => installerTokens.delete(token), 10 * 60 * 1000);
  return token;
}

function validateInstallerToken(token) {
  const entry = installerTokens.get(token);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > 10 * 60 * 1000) {
    installerTokens.delete(token);
    return null;
  }
  installerTokens.delete(token); // Single use
  return entry.agent;
}
```

The download endpoint generates a token and embeds it in the BAT:
```javascript
app.get('/download/call-monitor', requireAuth, (req, res) => {
  const agent = req.session.username;
  const token = generateInstallerToken(agent);
  // BAT uses the token (not the webhook secret) to download the PS1
  const bat = generateInstallerBat(baseUrl, token, agent);
  // ...
});
```

The PS1 download endpoint validates the token:
```javascript
app.get('/api/monitor-script', (req, res) => {
  const token = req.query.token;
  const agent = validateInstallerToken(token);
  if (!agent) return res.status(403).send('Invalid or expired token');
  // Generate PS1 with the real webhook secret embedded
  const script = generateMonitorScript(baseUrl, WEBHOOK_SECRET, agent);
  res.send(script);
});
```

The webhook secret is only in the PS1 file (on the user's machine in `%APPDATA%\ClinicaCallMonitor\call_monitor.ps1`), never in the BAT or the URL.

### 4.3 Issue 3: Unauthenticated WhatsApp Endpoints

**Fix: Extension API key authentication**

Generate a per-extension API key and require it on all WhatsApp endpoints:

```javascript
// middleware/extensionAuth.js
const EXTENSION_API_KEY = process.env.EXTENSION_API_KEY;

function requireExtensionAuth(req, res, next) {
  if (!EXTENSION_API_KEY) return next(); // Skip if not configured
  const provided = req.headers['x-extension-key'] || req.query.extensionKey;
  if (provided !== EXTENSION_API_KEY) {
    return res.status(401).json({ error: 'Invalid extension API key' });
  }
  next();
}

module.exports = { requireExtensionAuth };
```

Apply to WhatsApp routes:
```javascript
// routes/whatsapp.js
const { requireExtensionAuth } = require('../middleware/extensionAuth');

router.post('/incoming', requireExtensionAuth, async (req, res) => { ... });
router.get('/outgoing', requireExtensionAuth, (req, res) => { ... });
router.post('/sent', requireExtensionAuth, (req, res) => { ... });
```

The extension's `background.js` sends the key in every request:
```javascript
fetch(`${serverUrl}/api/whatsapp/incoming`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Extension-Key': extensionApiKey
  },
  body: JSON.stringify(msg.data)
});
```

The key is configured in the extension popup or embedded during download.

### 4.4 Issue 4: No Rate Limiting

```bash
npm install express-rate-limit
```

```javascript
// middleware/rateLimiter.js
const rateLimit = require('express-rate-limit');

// Global: 100 requests per 15 minutes per IP
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, try again later' }
});

// Login: 10 attempts per 15 minutes per IP
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many login attempts' }
});

// Webhook: 60 calls per minute (generous for legitimate use)
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Rate limit exceeded' }
});

// WhatsApp: 30 messages per minute
const waLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Rate limit exceeded' }
});

module.exports = { globalLimiter, loginLimiter, webhookLimiter, waLimiter };
```

Applied per-route:
```javascript
app.post('/login', loginLimiter, (req, res) => { ... });
app.post('/incoming_call', webhookLimiter, requireWebhookSecret, (req, res) => { ... });
app.post('/api/whatsapp/incoming', waLimiter, requireExtensionAuth, (req, res) => { ... });
```

### 4.5 Issue 5: Stricter CORS

```javascript
// middleware/cors.js
const allowedOrigins = [
  'https://web.whatsapp.com',
  process.env.EXTENSION_ORIGIN || ''  // Set to specific chrome-extension:// ID
];

function corsMiddleware(req, res, next) {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.some(o => o && origin.startsWith(o))) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, X-Extension-Key');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
}
```

### 4.6 Issue 6: Rotate Exposed Secrets

The following secrets are exposed in the Git history and must be rotated:
- `GROQ_API_KEY` — Generate a new key in the Groq dashboard
- `WEBHOOK_SECRET` — Generate a new random hex string: `node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"`
- `CLINICEA_API_KEY` — Contact Clinicea support for a new key
- `CLINICEA_STAFF_PASSWORD` — Change the password in Clinicea admin
- `SESSION_SECRET` — Generate a new one: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

---

## TASK 5 — CALL MONITOR IMPROVEMENTS

### 5.1 Current Issues

1. **User-context execution**: The PowerShell script runs as a user process (launched via VBS from the startup folder or a scheduled task with `/RL HIGHEST`). When the Windows user locks the screen, the script continues running. But when the user **logs out** (or the session is terminated), the script dies. Phone calls during off-hours are missed entirely.

2. **WinRT reflection complexity**: The monitor uses raw .NET reflection to access WinRT async APIs:
   ```powershell
   $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
       $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
       $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
   })[0]
   ```
   This is brittle — .NET and WinRT internals change between Windows versions. A Windows Update could break this silently.

3. **1-second polling**: The monitor calls `GetNotificationsAsync()` every second. This is:
   - CPU-wasteful (creates and awaits an async operation every second)
   - Latency-prone (up to 1 second delay between notification appearance and detection)
   - Battery-unfriendly on laptops

4. **No self-update**: If the PS1 script changes on the server, the installed monitor keeps running the old version forever. There's no version check or auto-update mechanism.

### 5.2 Option A: C# Windows Service (Best)

A C# Windows Service provides:

| Feature | PowerShell | C# Service |
|---------|-----------|------------|
| Runs after logout | No | Yes |
| Runs on boot (no login) | No | Yes |
| WinRT access | Via reflection | Native |
| Notification listener | Polling | Event-based |
| CPU usage | Higher (polling) | Minimal (events) |
| Update mechanism | Manual | Could auto-update |
| Installation | BAT + VBS | MSI or sc.exe |

**Architecture:**

```
ClinicCallMonitor.exe (Windows Service)
├── NotificationWatcher.cs    — WinRT UserNotificationListener with event subscription
├── CallDetector.cs           — Phone number extraction, duplicate suppression
├── WebhookClient.cs          — POST /incoming_call, POST /heartbeat, log upload
├── ServiceLifecycle.cs       — OnStart, OnStop, recovery configuration
└── Config.cs                 — Server URL, webhook secret, agent name
```

**Key implementation details:**

```csharp
// NotificationWatcher.cs
public class NotificationWatcher
{
    private UserNotificationListener _listener;
    private Timer _heartbeatTimer;

    public async Task StartAsync(string serverUrl, string secret, string agent)
    {
        _listener = UserNotificationListener.Current;
        var access = await _listener.RequestAccessAsync();
        if (access != UserNotificationListenerAccessStatus.Allowed)
            throw new InvalidOperationException("Notification access denied");

        // Event-based: fires when notification list changes
        _listener.NotificationChanged += OnNotificationChanged;

        // Heartbeat every 30 seconds
        _heartbeatTimer = new Timer(SendHeartbeat, null, 0, 30000);
    }

    private async void OnNotificationChanged(UserNotificationListener sender,
        UserNotificationChangedEventArgs args)
    {
        if (args.ChangeKind == UserNotificationChangedKind.Added)
        {
            var notification = await sender.GetNotification(args.UserNotificationId);
            ProcessNotification(notification);
        }
    }
}
```

**Benefits:**
- **Event-driven**: `NotificationChanged` fires immediately when a notification appears — zero polling, zero latency, zero CPU waste
- **Runs as a service**: Starts on boot, runs without any user logged in, survives logouts
- **Native WinRT**: No reflection hacks, direct API access via C#/WinRT projection
- **Proper service lifecycle**: OnStart/OnStop/OnPause, recovery actions (restart on crash), event log integration
- **Single EXE deployment**: Publish as a self-contained .exe, install with `sc create` or an MSI

**Installation:**
```batch
sc create "CliniceaCallMonitor" binpath="C:\Program Files\CliniceaCallMonitor\ClinicCallMonitor.exe" start=auto
sc start "CliniceaCallMonitor"
```

**Tradeoff:** Requires building and distributing a compiled binary. The current PS1 approach is easier to iterate on since it's just a text file. For a small clinic, the PS1 approach is "good enough" — the C# service is the right choice when reliability becomes critical (e.g., the clinic relies on the system for all incoming calls and cannot afford missed calls).

### 5.3 Option B: PowerShell Improvements (Incremental)

If staying with PowerShell, these improvements are achievable:

**1. Version check and auto-update:**
```powershell
# Check version every hour
$currentVersion = "2026-03-10"
$versionUrl = "$baseUrl/api/monitor-version?agent=$agentName"
try {
    $serverVersion = (Invoke-RestMethod -Uri $versionUrl -TimeoutSec 5).version
    if ($serverVersion -ne $currentVersion) {
        Write-Log "New version available: $serverVersion (current: $currentVersion)"
        # Re-download PS1
        $scriptUrl = "$baseUrl/api/monitor-script?agent=$agentName&secret=$webhookSecret"
        Invoke-WebRequest -Uri $scriptUrl -OutFile $PSCommandPath -UseBasicParsing
        Write-Log "Updated to version $serverVersion — restarting..."
        Start-Process powershell -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`"" -WindowStyle Hidden
        exit 0
    }
} catch { Write-Log "Version check failed: $_" }
```

**2. Register as a scheduled task that runs whether user is logged in or not:**
```batch
schtasks /Create /TN "Clinicea Call Monitor" /SC ONSTART /RU SYSTEM /TR "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"%PS1_FILE%\"" /F
```

Note: Running as SYSTEM may affect WinRT notification access. Needs testing.

---

## TASK 6 — DATABASE IMPROVEMENTS

### 6.1 Current SQLite Limitations

| Limitation | Impact | Severity |
|-----------|--------|----------|
| Single-writer | Concurrent webhook calls queue on write lock | Low (current volume is <1 call/min) |
| No network access | Cannot split read/write or add replicas | Low (single server) |
| No built-in replication | No automatic backup to another location | Medium (data loss risk) |
| Manual migrations | Schema changes are ad-hoc ALTER TABLEs in try/catch | Medium (technical debt) |
| No full-text search | Patient search is JS `.filter().includes()` on cached array | Low |
| 2GB practical limit | Large databases slow down | Low (years to reach) |

### 6.2 SQLite Improvements (Recommended Now)

Before migrating to PostgreSQL, these SQLite improvements add significant value:

**1. Automated backups:**
```javascript
// Run daily: copy calls.db to a backup location
const fs = require('fs');
function backupDatabase() {
  const src = path.join(__dirname, 'calls.db');
  const dest = path.join(__dirname, `backups/calls_${new Date().toISOString().split('T')[0]}.db`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  // Keep last 30 backups
  const files = fs.readdirSync(path.join(__dirname, 'backups')).sort();
  while (files.length > 30) {
    fs.unlinkSync(path.join(__dirname, 'backups', files.shift()));
  }
  logEvent('info', `Database backup created: ${path.basename(dest)}`);
}
setInterval(backupDatabase, 24 * 60 * 60 * 1000); // Daily
```

**2. Indexes for common queries:**
```sql
CREATE INDEX IF NOT EXISTS idx_calls_agent ON calls(agent);
CREATE INDEX IF NOT EXISTS idx_calls_timestamp ON calls(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_calls_caller ON calls(caller_number);
CREATE INDEX IF NOT EXISTS idx_wa_messages_phone ON wa_messages(phone);
CREATE INDEX IF NOT EXISTS idx_wa_messages_status ON wa_messages(status);
CREATE INDEX IF NOT EXISTS idx_wa_messages_created ON wa_messages(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wa_apt_tracking_phone ON wa_appointment_tracking(patient_phone);
```

**3. Migration tracking** (as shown in Task 2, `db/migrations.js`).

### 6.3 PostgreSQL Migration Path (Future)

When to migrate: if the system needs to support multiple server instances, or if the clinic grows to 50+ agents and thousands of calls per day.

**Schema mapping:**

```sql
-- PostgreSQL schema
CREATE TABLE calls (
    id SERIAL PRIMARY KEY,
    caller_number VARCHAR(20) NOT NULL,
    call_sid VARCHAR(100),
    clinicea_url TEXT,
    patient_name VARCHAR(200),
    patient_id VARCHAR(50),
    agent VARCHAR(50),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_calls_agent ON calls(agent);
CREATE INDEX idx_calls_created ON calls(created_at DESC);
CREATE INDEX idx_calls_caller ON calls(caller_number);

CREATE TABLE wa_messages (
    id SERIAL PRIMARY KEY,
    phone VARCHAR(20) NOT NULL,
    chat_name VARCHAR(200),
    direction VARCHAR(3) NOT NULL CHECK (direction IN ('in', 'out')),
    message TEXT NOT NULL,
    message_type VARCHAR(20) DEFAULT 'chat',
    status VARCHAR(20) DEFAULT 'sent',
    agent VARCHAR(50),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE wa_appointment_tracking (
    id SERIAL PRIMARY KEY,
    appointment_id VARCHAR(100) UNIQUE NOT NULL,
    patient_id VARCHAR(50),
    patient_name VARCHAR(200),
    patient_phone VARCHAR(20),
    appointment_date TIMESTAMP WITH TIME ZONE,
    doctor_name VARCHAR(200),
    service VARCHAR(200),
    confirmation_sent BOOLEAN DEFAULT FALSE,
    reminder_sent BOOLEAN DEFAULT FALSE,
    confirmation_sent_at TIMESTAMP WITH TIME ZONE,
    reminder_sent_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

**Migration steps:**
1. Install `pg` package: `npm install pg`
2. Create PostgreSQL database on VPS: `createdb clinicea_calls`
3. Export SQLite data: `sqlite3 calls.db .dump > dump.sql`
4. Transform dump to PostgreSQL syntax (INTEGER -> SERIAL, datetime -> timestamp, etc.)
5. Import: `psql clinicea_calls < dump_pg.sql`
6. Update all `db.prepare()` calls to use `pg` pool queries
7. Test thoroughly on a staging instance
8. Switch `.env` to PostgreSQL connection string
9. Deploy

---

## TASK 7 — CALL ROUTING IMPROVEMENT

### 7.1 Current Limitations

Currently, calls are routed based on which Windows PC detected the call:

```
Phone rings → PC with Phone Link detects → Monitor sends POST with Agent=agent1 → Server routes to agent1
```

Problems:
1. **Coupled to physical hardware** — if agent1's PC is off but agent1 is logged into the dashboard on a laptop, they don't receive calls
2. **No load balancing** — if two monitors are running (desktop + laptop for the same agent), duplicate events are sent
3. **No reassignment** — if agent1 is busy or away, the call cannot be routed to agent2
4. **Doctor's phone is shared** — the clinic has one phone number; any agent could answer the call

### 7.2 Option A: First-Agent-Lock System (Recommended)

This is the most practical improvement for a small clinic:

**How it works:**

1. Incoming call arrives from the monitor (tagged to the agent whose PC detected it)
2. Server broadcasts the call to ALL agents (not just the tagged one)
3. Each agent's dashboard shows a "Claim Call" button
4. The first agent who clicks "Claim Call" is assigned the call
5. All other agents see the call disappear or show "Claimed by agent2"
6. The assigned agent's dashboard auto-opens the Clinicea profile

**Implementation:**

Server-side:
```javascript
// routes/calls.js
app.post('/api/claim-call', requireAuth, (req, res) => {
  const { callId } = req.body;
  const agent = req.session.username;

  // Atomic claim: check and update in a transaction
  const call = db.prepare('SELECT id, claimed_by FROM calls WHERE id = ?').get(callId);
  if (!call) return res.json({ error: 'Call not found' });
  if (call.claimed_by) return res.json({ error: 'Already claimed', claimedBy: call.claimed_by });

  db.prepare('UPDATE calls SET claimed_by = ?, claimed_at = datetime("now") WHERE id = ?').run(agent, callId);

  // Notify all dashboards that this call is claimed
  io.emit('call_claimed', { callId, claimedBy: agent });

  logEvent('info', `Call ${callId} claimed by ${agent}`);
  return res.json({ ok: true, claimedBy: agent });
});
```

Database change:
```sql
ALTER TABLE calls ADD COLUMN claimed_by TEXT;
ALTER TABLE calls ADD COLUMN claimed_at DATETIME;
```

Frontend:
```javascript
socket.on('incoming_call', (data) => {
  // Show notification with "Claim" button for all agents
  showNotification(data);
  showClaimButton(data.callId);
});

socket.on('call_claimed', (data) => {
  if (data.claimedBy === myUsername) {
    // I claimed it — open the profile
    window.open(getClinicaUrl(data.callId), 'clinicea_patient');
  } else {
    // Someone else claimed it — dismiss notification
    hideNotification(data.callId);
    showToast(`Call claimed by ${data.claimedBy}`);
  }
});

async function claimCall(callId) {
  const res = await fetch('/api/claim-call', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callId })
  });
  const data = await res.json();
  if (data.error) {
    showToast(data.error);
  }
}
```

### 7.3 Option B: Round-Robin Distribution

For automatic distribution without manual claiming:

```javascript
// services/callRouter.js
let lastAssignedIndex = -1;
const activeAgents = ['agent1', 'agent2', 'agent3', 'agent4', 'agent5'];

function getNextAgent() {
  // Filter to agents with active sockets
  const online = activeAgents.filter(agent => {
    const room = io.sockets.adapter.rooms.get('agent:' + agent);
    return room && room.size > 0;
  });

  if (online.length === 0) return null;

  lastAssignedIndex = (lastAssignedIndex + 1) % online.length;
  return online[lastAssignedIndex];
}
```

**Tradeoff:** Round-robin is simpler but doesn't account for agent availability (busy with current patient, stepped away). The claim-based system is more flexible for a small clinic where agents have varying availability.

---

## TASK 8 — EVENT PROCESSING IMPROVEMENT

### 8.1 Current Architecture

The incoming call webhook is processed synchronously in the Express request handler:

```
POST /incoming_call
  → normalize phone
  → INSERT into SQLite
  → emit Socket.IO event (sync)
  → trigger async Clinicea patient lookup
  → respond 200 OK
```

Problems:
- If SQLite is slow (WAL checkpoint, disk I/O), the monitor's webhook call times out
- If Socket.IO emit is slow (many connections), the response is delayed
- If the Clinicea API is down, the `.then()` chain hangs silently
- No retry if the webhook partially fails (e.g., DB insert succeeds but socket emit crashes)

### 8.2 Message Queue Architecture

**Recommended: BullMQ + Redis**

If Redis is added for session storage (future), BullMQ provides job queues with retries, delays, and rate limiting.

```
POST /incoming_call
  ↓
  Validate & respond 200 immediately
  ↓
  Enqueue job: { caller, callSid, agent }
  ↓
  Worker picks up job:
    1. Normalize phone
    2. INSERT into database
    3. Emit Socket.IO event
    4. Lookup patient in Clinicea
    5. Emit patient_info event
    6. If any step fails, retry with backoff
```

**Implementation:**

```bash
npm install bullmq ioredis
```

```javascript
// services/callQueue.js
const { Queue, Worker } = require('bullmq');
const IORedis = require('ioredis');

const connection = new IORedis({ maxRetriesPerRequest: null });
const callQueue = new Queue('incoming-calls', { connection });

// Producer (in route handler)
async function enqueueCall(callData) {
  await callQueue.add('process-call', callData, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 }
  });
}

// Worker (started on server boot)
const worker = new Worker('incoming-calls', async (job) => {
  const { caller, callSid, agent } = job.data;
  // ... full processing pipeline
}, {
  connection,
  concurrency: 5
});

worker.on('failed', (job, err) => {
  logEvent('error', `Call processing failed after ${job.attemptsMade} attempts`, err.message);
});
```

**When to implement:** When Redis is already in the stack (for sessions or caching). Adding Redis solely for a job queue is overkill for a clinic with <1 call/minute. The current synchronous approach works fine at this scale.

### 8.3 Lightweight Alternative: In-Process Queue

For current scale, a simple in-process async queue provides retries without Redis:

```javascript
// services/callProcessor.js
class CallProcessor {
  constructor() {
    this.queue = [];
    this.processing = false;
  }

  enqueue(callData) {
    this.queue.push({ data: callData, attempts: 0, maxAttempts: 3 });
    this.processNext();
  }

  async processNext() {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;

    const job = this.queue.shift();
    try {
      await this.processCall(job.data);
    } catch (err) {
      job.attempts++;
      if (job.attempts < job.maxAttempts) {
        this.queue.push(job); // Re-queue for retry
        logEvent('warn', `Call processing retry ${job.attempts}/${job.maxAttempts}`, err.message);
      } else {
        logEvent('error', `Call processing failed permanently`, err.message);
      }
    }

    this.processing = false;
    if (this.queue.length > 0) setImmediate(() => this.processNext());
  }

  async processCall(data) {
    // 1. Normalize, 2. DB insert, 3. Socket emit, 4. Patient lookup
  }
}
```

---

## TASK 9 — LOGGING IMPROVEMENTS

### 9.1 Current Logging

```javascript
function logEvent(type, message, details) {
  const entry = { type, message, details: details || null, time: new Date().toISOString() };
  eventLog.push(entry);
  if (eventLog.length > MAX_LOG) eventLog.shift();
  io.emit('server_log', entry);
  const prefix = type === 'error' ? '[ERROR]' : type === 'warn' ? '[WARN]' : '[INFO]';
  console.log(`${prefix} ${message}${details ? ' | ' + details : ''}`);
}
```

Problems:
- Text-based console output is hard to parse programmatically
- No log levels (debug/trace are missing)
- No log rotation — PM2 handles stdout/stderr, but log files grow unbounded
- No structured metadata (request ID, agent, endpoint)
- The in-memory `eventLog` (last 50 events) is lossy and lost on restart

### 9.2 Pino Integration

```bash
npm install pino pino-pretty
```

```javascript
// utils/logger.js
const pino = require('pino');

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: process.env.NODE_ENV !== 'production' ? {
    target: 'pino-pretty',
    options: { colorize: true, translateTime: 'SYS:HH:MM:ss' }
  } : undefined,
  // Production: JSON output (parseable by log aggregators)
  formatters: {
    level: (label) => ({ level: label })
  }
});

// Backward-compatible logEvent function
const eventLog = [];
const MAX_LOG = 50;

function logEvent(type, message, details) {
  const entry = { type, message, details: details || null, time: new Date().toISOString() };
  eventLog.push(entry);
  if (eventLog.length > MAX_LOG) eventLog.shift();

  // Structured JSON logging
  const logData = { msg: message, details, eventType: type };
  if (type === 'error') logger.error(logData);
  else if (type === 'warn') logger.warn(logData);
  else logger.info(logData);

  // Emit to dashboard (unchanged)
  try { io.emit('server_log', entry); } catch (e) {}
}

module.exports = { logger, logEvent, eventLog };
```

**Production output (JSON):**
```json
{"level":"info","time":1710000000000,"msg":"POST /incoming_call received","details":"From: \"+923001234567\" | Agent: \"agent1\"","eventType":"info"}
{"level":"info","time":1710000000050,"msg":"Incoming call: +923001234567","details":"Agent: agent1 | SID: local-1710000000 | Sockets: agent:agent1=2, role:admin=1","eventType":"info"}
```

**Benefits:**
- JSON logs are parseable by log aggregation tools (Grafana Loki, ELK, etc.)
- Log levels allow filtering (set `LOG_LEVEL=debug` for troubleshooting)
- Pino is the fastest Node.js logger (~3x faster than Winston)
- Pretty output in development, JSON in production
- PM2 can manage log rotation: `pm2 install pm2-logrotate`

### 9.3 Request Logging

```bash
npm install pino-http
```

```javascript
// app.js
const pinoHttp = require('pino-http');
app.use(pinoHttp({ logger }));
```

This adds automatic request/response logging:
```json
{"level":"info","time":1710000000000,"req":{"method":"POST","url":"/incoming_call"},"res":{"statusCode":200},"responseTime":12}
```

---

## TASK 10 — SYSTEM MONITORING

### 10.1 Health Check Endpoint

```javascript
// routes/admin.js
app.get('/api/health', (req, res) => {
  const uptime = process.uptime();
  const memory = process.memoryUsage();
  const sockets = io.sockets.sockets.size;

  // Check agent monitors
  const monitors = {};
  for (const [agent, state] of Object.entries(agentHeartbeats)) {
    monitors[agent] = {
      alive: state.alive,
      lastHeartbeat: state.lastHeartbeat,
      staleSec: Math.round((Date.now() - state.lastHeartbeat) / 1000)
    };
  }

  // Database check
  let dbOk = false;
  try {
    db.prepare('SELECT 1').get();
    dbOk = true;
  } catch (e) {}

  // Clinicea API check
  const cliniceaConfigured = isClinicaConfigured();
  const cliniceaTokenValid = cliniceaToken && Date.now() < tokenExpiry;

  res.json({
    status: 'ok',
    uptime: Math.round(uptime),
    uptimeHuman: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`,
    memory: {
      rss: Math.round(memory.rss / 1024 / 1024) + 'MB',
      heapUsed: Math.round(memory.heapUsed / 1024 / 1024) + 'MB',
      heapTotal: Math.round(memory.heapTotal / 1024 / 1024) + 'MB'
    },
    sockets: {
      total: sockets,
      rooms: Object.fromEntries(
        [...io.sockets.adapter.rooms.entries()]
          .filter(([name]) => !io.sockets.sockets.has(name))
          .map(([name, set]) => [name, set.size])
      )
    },
    monitors,
    database: dbOk ? 'ok' : 'error',
    clinicea: {
      configured: cliniceaConfigured,
      tokenValid: cliniceaTokenValid,
      tokenExpiresIn: cliniceaTokenValid ? Math.round((tokenExpiry - Date.now()) / 60000) + 'min' : null
    },
    eventLog: {
      recentErrors: eventLog.filter(e => e.type === 'error').length,
      total: eventLog.length
    }
  });
});
```

### 10.2 Dashboard Metrics Panel

Add a "System" page to the dashboard sidebar showing:

| Metric | Source | Update Method |
|--------|--------|---------------|
| Server Uptime | `/api/health` | Poll every 30s |
| Active Sockets | `/api/health` | Poll every 30s |
| Connected Monitors | `/api/health` | Poll every 30s |
| Recent Errors (last 50) | `/api/logs` | Socket.IO `server_log` event |
| Memory Usage | `/api/health` | Poll every 30s |
| Clinicea API Status | `/api/health` | Poll every 30s |
| Call Count Today | `/api/calls` | Updated on `incoming_call` event |
| WA Messages Today | `/api/whatsapp/stats` | Poll every 60s |

### 10.3 External Monitoring

Set up an uptime monitor (e.g., UptimeRobot, free tier) to ping `/api/health` every 5 minutes. Alert via email/SMS if the server is down.

```
Monitor URL: https://clinicea.scalamatic.com/api/health
Expected status: 200
Check interval: 5 minutes
Alert: Email + SMS
```

---

## TASK 11 — DOCUMENTATION IMPROVEMENTS

### SECTION 14 — SYSTEM DEPENDENCY GRAPH

```
EXTERNAL DEPENDENCIES
=====================

┌─────────────┐     ┌──────────────────┐     ┌───────────────┐
│   Patient    │     │  Clinic Mobile   │     │   WhatsApp    │
│   (caller)   │────▶│     Phone        │     │  (patient)    │
└─────────────┘     └──────┬───────────┘     └───────┬───────┘
                           │                         │
                    Phone call                  WhatsApp message
                           │                         │
                    ┌──────▼───────────┐     ┌───────▼───────┐
                    │  Microsoft       │     │  WhatsApp Web │
                    │  Phone Link      │     │  (browser)    │
                    │  (Windows app)   │     └───────┬───────┘
                    └──────┬───────────┘             │
                           │                  ┌──────▼────────┐
                    Windows notification      │ Chrome        │
                           │                  │ Extension     │
                    ┌──────▼───────────┐      │ (content.js)  │
                    │  PowerShell      │      └───────┬───────┘
                    │  Call Monitor    │              │
                    │  (call_monitor   │       POST /api/whatsapp
                    │   .ps1)          │       /incoming
                    └──────┬───────────┘              │
                           │                          │
                    POST /incoming_call               │
                    POST /heartbeat                   │
                           │                          │
                    ┌──────▼──────────────────────────▼┐
                    │                                   │
                    │     Node.js Express Server        │
                    │     (server.js on VPS)             │
                    │                                   │
                    │  ┌────────────┐  ┌─────────────┐ │
                    │  │  SQLite    │  │  Socket.IO   │ │
                    │  │  (calls.db)│  │  (rooms)     │ │
                    │  └────────────┘  └──────┬──────┘ │
                    │                         │        │
                    │  ┌────────────────────┐  │        │
                    │  │  Clinicea API      │  │        │
                    │  │  (patient lookup)  │  │        │
                    │  └────────────────────┘  │        │
                    │                         │        │
                    │  ┌────────────────────┐  │        │
                    │  │  Groq API          │  │        │
                    │  │  (Llama 3.1 8B)    │  │        │
                    │  └────────────────────┘  │        │
                    │                         │        │
                    └─────────────────────────┼────────┘
                                              │
                                       WebSocket events
                                              │
                    ┌─────────────────────────▼────────┐
                    │                                   │
                    │     Browser Dashboard             │
                    │     (public/index.html)            │
                    │                                   │
                    │  ┌────────────┐  ┌─────────────┐ │
                    │  │ Call       │  │  Clinicea    │ │
                    │  │ History    │  │  Profile     │ │
                    │  │ Table      │  │  (popup)     │ │
                    │  └────────────┘  └─────────────┘ │
                    │                                   │
                    └───────────────────────────────────┘
```

**Runtime Dependencies:**

| Component | Depends On | Failure Impact |
|-----------|-----------|----------------|
| Call Monitor (PS1) | Windows, Phone Link, Network | Calls not detected |
| Server (Node.js) | VPS, PM2, Network | Everything stops |
| SQLite (calls.db) | Filesystem | Call history lost |
| Clinicea API | Internet, Clinicea servers | Patient lookup fails (calls still logged) |
| Groq API | Internet, Groq servers | WhatsApp bot replies fail (messages still logged) |
| Chrome Extension | Chrome, WhatsApp Web | WhatsApp bot stops |
| Dashboard | Browser, Server, Socket.IO | Agents can't see calls (calls still logged) |
| Phone Link | Windows, Bluetooth/WiFi, Phone | Notifications not mirrored |

### SECTION 15 — FAILURE SCENARIOS

#### Scenario 1: Phone Link Disconnects

**Trigger:** Bluetooth drops, WiFi changes, Phone Link crashes, phone restarts

**Behavior:**
- Monitor keeps running but `GetNotificationsAsync()` returns stale/empty list
- No new call notifications appear
- Heartbeat continues — dashboard shows "Monitor: On" (misleading)
- Calls are missed silently

**Detection:**
- Monitor log shows `DIAG: GetNotificationsAsync returned 0 notifications`
- No new call records despite known incoming calls

**Recovery:**
- Reconnect Phone Link (check Bluetooth/WiFi, reopen Phone Link app)
- Monitor automatically picks up new notifications once Phone Link reconnects
- No server-side action needed

**Mitigation:**
- Monitor logs notification count changes for diagnostic
- Consider adding a "last call detected" timestamp to heartbeat data

#### Scenario 2: Monitor Stops

**Trigger:** Windows logout, PS1 crash, PC shutdown, VBS launcher killed

**Behavior:**
- Heartbeat stops arriving at server
- After 90 seconds, server marks monitor as dead
- Dashboard shows "Monitor: Off" (red dot)
- `monitor_status` event emitted to relevant agent + admin
- All calls are missed until monitor restarts

**Detection:**
- Dashboard "Monitor: Off" indicator
- `logEvent('warn', 'Call monitor disconnected: agent1')`
- Admin `/api/socket-debug` shows no heartbeat for the agent

**Recovery:**
- If PC is on: run `start_monitor.vbs` manually or restart the scheduled task
- If PC restarted: monitor starts automatically via startup folder / scheduled task
- Re-download installer from dashboard if script is corrupted

#### Scenario 3: Server Restarts

**Trigger:** `pm2 restart`, deployment, server crash, VPS reboot

**Behavior:**
- All Socket.IO connections drop immediately
- All in-memory sessions are lost (MemoryStore)
- All in-memory caches are lost (patient cache, appointment cache, meeting cache)
- `eventLog` is lost
- `pausedChats` set is lost
- `agentHeartbeats` map is reset
- Dashboard shows "Disconnected" → reconnects within seconds
- Socket reconnects but session is invalid → `join_confirm` with error
- User prompted to re-login
- Monitor heartbeat arrives → `agentHeartbeats` repopulated
- Startup grace period (120s) prevents false "monitor dead" alerts

**Detection:**
- Dashboard "No Session" status → re-login prompt
- Server log: `[INFO] Server started on port 3000`

**Recovery:**
- Users must re-login (fixed by persistent session store — see Task 3)
- Caches rebuild on first request
- Monitor heartbeat reappears within 30 seconds
- 120-second grace period prevents false alerts

#### Scenario 4: Session Expires

**Trigger:** Cookie maxAge (24h) exceeded, server restart (MemoryStore), manual logout

**Behavior:**
- HTTP API calls return 401 → frontend redirect to `/login`
- Socket.IO connection persists but `socket.request.session.username` is undefined
- `join_confirm` event sent with `error: 'Session not found'`
- Dashboard shows "No Session" and prompts re-login
- Socket receives NO call events (no rooms joined)

**Detection:**
- Dashboard status: "No Session"
- Browser console: `[Dashboard] ROOM JOIN FAILED: Session not found`

**Recovery:**
- Click OK on re-login prompt → redirected to `/login`
- After login, socket reconnects and joins correct rooms

#### Scenario 5: Socket Disconnects

**Trigger:** Network interruption, browser sleep, tab backgrounded, server restart

**Behavior:**
- Dashboard shows "Disconnected" (red dot)
- Socket.IO auto-reconnects with exponential backoff
- On reconnect, session is re-read from cookie
- `join_confirm` event confirms room membership
- Any calls during disconnect are missed in real-time but appear on page refresh (from DB)

**Detection:**
- Dashboard "Disconnected" status
- Browser console: `[Dashboard] Socket disconnected`

**Recovery:**
- Automatic — Socket.IO reconnects within seconds
- If session is valid, rooms are re-joined automatically
- Call history loads from database on reconnect

#### Scenario 6: Clinicea API Fails

**Trigger:** Clinicea servers down, API key expired, staff password changed, network issue

**Behavior:**
- Patient lookup fails silently (`.catch(() => {})`)
- Call is still logged to database with phone number
- `incoming_call` event is still emitted (without patient name)
- `patient_info` event is NOT emitted
- Dashboard shows "--" instead of patient name
- "Next Meeting" shows "Error"
- Patient profile modal shows error message
- Appointment calendar is empty
- Patient directory shows "Clinicea API not configured"

**Detection:**
- `logEvent('error', 'Clinicea API login failed')` or `logEvent('error', 'Clinicea API error')`
- Dashboard: patient names missing, next meetings showing "Error"

**Recovery:**
- Verify Clinicea API credentials in `.env`
- Check Clinicea server status
- Token auto-refreshes on 401 — if credentials are correct, it recovers automatically
- Restart server to force fresh login: `pm2 restart clinicea-call`

### SECTION 16 — PERFORMANCE LIMITS

#### Tested/Theoretical Limits

| Metric | Practical Limit | Bottleneck | Notes |
|--------|----------------|------------|-------|
| **Concurrent agents** | ~50 | Socket.IO memory (~100KB per socket) | Current: 6 users configured |
| **Concurrent sockets** | ~1000 | Node.js event loop, OS file descriptors | Each browser tab = 1 socket |
| **Calls per minute** | ~60 | SQLite write serialization (WAL mode) | Current: <1 call/min |
| **Calls per second** | ~10 | SQLite IOPS + Socket.IO emit fanout | Would need connection pooling beyond this |
| **Patient cache size** | ~50,000 | In-memory array, linear `.filter()` search | Current: <5000, 10min TTL |
| **WhatsApp messages/min** | ~12 | 5-second scan interval in content script | Bot-limited, not server-limited |
| **Groq API calls/min** | ~30 | Groq rate limit (free tier) | Shared across all chats |
| **Database size** | ~2GB | SQLite practical limit before slowdown | Years to reach at current volume |
| **Server memory** | ~200MB typical | Node.js heap + SQLite cache + caches | MemoryStore leak adds ~1MB/day |
| **Socket.IO rooms** | Unlimited | No practical limit with current design | Currently: 1 per agent + 1 admin |
| **Event log buffer** | 50 events | Hard-coded `MAX_LOG = 50` | Oldest events are dropped |
| **Heartbeat staleness** | 90 seconds | `HEARTBEAT_STALE_MS = 90000` | Generous for network hiccups |
| **Startup grace period** | 120 seconds | `STARTUP_GRACE_MS = 120000` | Prevents false dead-monitor alerts |

#### Scaling Thresholds

| Scale Point | Action Needed |
|-------------|---------------|
| >10 agents | Add persistent sessions (SQLite store) |
| >50 agents | Consider PostgreSQL, add indexes |
| >100 concurrent sockets | Increase OS file descriptor limits |
| >1000 calls/day | Add database indexes, consider message queue |
| >5000 patients | Add full-text search index or paginated API search |
| >1 server instance | Migrate to PostgreSQL + Redis, use Socket.IO Redis adapter |

### SECTION 17 — DATA FLOW DIAGRAM

#### Call Detection Flow

```
┌──────────────────────────────────────────────────────────────────┐
│                        INCOMING CALL FLOW                         │
└──────────────────────────────────────────────────────────────────┘

[1] Patient dials clinic phone
        │
        ▼
[2] Phone rings ─── Phone Link mirrors notification to Windows
        │
        ▼
[3] Windows Notification Center shows toast
    App: "Phone Link" / "Your Phone"
    Text: "Incoming call | +923001234567"
        │
        ▼
[4] PowerShell Monitor (call_monitor.ps1)
    ├── GetNotificationsAsync() polls every 1 second
    ├── Detects new notification ID (not in seenIds)
    ├── Checks appName/appId for Phone Link match
    ├── Checks text for call keywords
    ├── Extracts phone number via 3-method cascade:
    │   Method 1: Strip keywords, find number pattern
    │   Method 2: Search full text for number pattern
    │   Method 3: Search individual text elements
    ├── Deduplication check (30-second window per number)
    └── Sends webhook with 3 retries
        │
        ▼
[5] POST /incoming_call
    Headers: X-Webhook-Secret: <secret>
    Body: From=+923001234567&CallSid=local-1710000000&Agent=agent1
        │
        ▼
[6] Server processing (server.js lines 228-299)
    ├── requireWebhookSecret middleware validates secret
    ├── normalizePKPhone() converts 03XXXXXXXXX → +92XXXXXXXXX
    ├── Validates agent (must be known username in USERS)
    ├── Constructs Clinicea lookup URL
    ├── INSERT into calls table (SQLite)
    ├── Constructs callEvent object
    ├── Routes to Socket.IO rooms:
    │   If agent known: emit to agent:<name> + role:admin
    │   If agent unknown: emit to ALL sockets
    └── Triggers async patient lookup (non-blocking)
        │
        ├───────────────────────┐
        ▼                       ▼
[7] Socket.IO event          [8] Clinicea API lookup
    incoming_call                  ├── findPatientByPhone()
    {                              │   ├── v2/getPatient (by mobile)
      caller: "+923001234567",     │   └── getChanges (appointment match)
      callId: 42,                  ├── UPDATE calls SET patient_name
      cliniceaUrl: "https://       └── Emit patient_info event
        app.clinicea.com/             {
        clinic.aspx?tp=pat&             caller: "+923001234567",
        m=+923001234567",               callId: 42,
      agent: "agent1",                  patientName: "Ahmed Khan",
      timestamp: "2026-03-10..."        patientID: "12345"
    }                                }
        │
        ▼
[9] Dashboard receives event (public/index.html)
    ├── isEventForMe() ownership check
    ├── Show notification banner (yellow, pulsing)
    ├── Display caller number + WhatsApp link
    ├── Play beep sound (880Hz + 1100Hz)
    ├── Auto-open Clinicea profile (agents only, not admin):
    │   window.open(cliniceaUrl, 'clinicea_patient')
    │   ├── If popup blocked: show red fallback link
    │   └── localStorage lock prevents duplicate opens (multi-tab)
    └── Refresh call history table
        │
        ▼
[10] Clinicea EMR opens in new tab/window
     Patient profile page with:
     ├── Patient demographics
     ├── Appointment history
     ├── Treatment records
     └── Billing information
```

#### WhatsApp Bot Flow

```
┌──────────────────────────────────────────────────────────────────┐
│                       WHATSAPP BOT FLOW                           │
└──────────────────────────────────────────────────────────────────┘

[1] Patient sends WhatsApp message
        │
        ▼
[2] web.whatsapp.com shows unread badge
        │
        ▼
[3] Chrome Extension content.js
    ├── Scans sidebar every 5 seconds (findUnreadChats)
    ├── Identifies unread badge spans
    ├── Filters out groups and known patterns
    ├── Clicks chat to open it
    ├── Reads last incoming message (getLastIncomingMessages)
    ├── Checks processedMessages set (skip if seen)
    └── Sends to background.js via chrome.runtime.sendMessage
        │
        ▼
[4] background.js
    └── POST /api/whatsapp/incoming
        Body: { messageId, text, phone, chatName, timestamp }
        │
        ▼
[5] Server processing
    ├── Check if bot is paused for this chat
    ├── INSERT wa_messages (direction: 'in')
    ├── getGPTReply():
    │   ├── Load conversation history (last 20 messages)
    │   ├── Build messages array with system prompt
    │   ├── POST to Groq API (Llama 3.1 8B Instant)
    │   └── fixReplyLinks() — replace [LINK:tag] with URLs
    ├── INSERT wa_messages (direction: 'out')
    └── Return { reply: "..." } to extension
        │
        ▼
[6] content.js receives reply
    ├── Types reply into compose box (character by character)
    ├── Simulates Enter key to send
    └── Navigates back to chat list
```

---

## TASK 12 — FINAL OUTPUT: REVISED ARCHITECTURE BLUEPRINT

### Implementation Priority

| Priority | Task | Effort | Impact |
|----------|------|--------|--------|
| **P0 — Critical** | Persistent sessions (SQLite store) | 1 hour | Fixes session loss on restart |
| **P0 — Critical** | WhatsApp endpoint authentication | 1 hour | Closes open API vulnerability |
| **P0 — Critical** | Rotate exposed secrets | 30 min | Invalidates leaked credentials |
| **P1 — High** | Rate limiting | 1 hour | Prevents abuse |
| **P1 — High** | bcrypt password hashing | 1 hour | Removes plaintext passwords |
| **P1 — High** | Database indexes | 15 min | Improves query performance |
| **P1 — High** | Database backups | 30 min | Prevents data loss |
| **P2 — Medium** | Modular file structure | 4 hours | Improves maintainability |
| **P2 — Medium** | Structured logging (Pino) | 1 hour | Improves debugging |
| **P2 — Medium** | Health check endpoint | 30 min | Enables monitoring |
| **P2 — Medium** | One-time installer tokens | 2 hours | Protects webhook secret |
| **P2 — Medium** | Migration tracking system | 1 hour | Manages schema changes |
| **P3 — Low** | Call claiming system | 3 hours | Enables multi-agent routing |
| **P3 — Low** | C# Windows Service | 2 days | Improves monitor reliability |
| **P3 — Low** | PostgreSQL migration | 1 day | Enables scaling |
| **P3 — Low** | BullMQ job queue | 4 hours | Adds processing resilience |
| **P3 — Low** | Frontend refactoring | 2 days | Improves frontend maintainability |

### Recommended Implementation Order

**Phase 1 — Security Hardening (1 day)**
1. Rotate all exposed secrets
2. Add `better-sqlite3-session-store` for persistent sessions
3. Add `express-rate-limit` on all endpoints
4. Add extension API key authentication for WhatsApp endpoints
5. Implement bcrypt password hashing
6. Add database indexes

**Phase 2 — Reliability (1 day)**
1. Add database backup system
2. Add health check endpoint (`/api/health`)
3. Add migration tracking system
4. Set up external uptime monitoring (UptimeRobot)
5. Add Pino structured logging

**Phase 3 — Architecture (2-3 days)**
1. Extract modules (incremental, as described in Task 2)
2. Add one-time installer tokens
3. Implement call claiming system

**Phase 4 — Future (when needed)**
1. C# Windows Service for monitor
2. PostgreSQL migration
3. Redis + BullMQ
4. Frontend component framework

### Quick Wins (Can Be Done Today)

These changes require minimal code and provide immediate security/reliability improvements:

1. **Add `better-sqlite3-session-store`** — 5 lines of code change, fixes the #1 reliability issue
2. **Add `express-rate-limit`** — 10 lines, prevents abuse
3. **Add database indexes** — 6 SQL statements, improves performance
4. **Rotate secrets** — Generate new values, update `.env` on VPS
5. **Add extension API key** — 1 new env var, 1 middleware function, header check in background.js

---

*This document provides a complete architectural analysis and upgrade roadmap. A developer can use this to understand the system's current state, its weaknesses, and the prioritized steps to improve it. Each recommendation includes implementation details sufficient to execute without further research.*
