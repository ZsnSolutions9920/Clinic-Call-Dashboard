require('dotenv').config();
const express = require('express');
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
const recentCalls = db.prepare(
  'SELECT * FROM calls ORDER BY timestamp DESC LIMIT 50'
);

// --- Middleware ---
app.use(express.urlencoded({ extended: false })); // Twilio sends form-encoded
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Routes ---

// Twilio webhook - incoming call handler
app.post('/incoming_call', (req, res) => {
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

  // Respond with TwiML to forward the call to doctor's mobile
  const twilioNumber = req.body.To || req.body.Called;
  res.type('text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">Please hold while we connect you to the doctor.</Say>
    <Dial timeout="40" callerId="${twilioNumber}">
        <Number>${DOCTOR_PHONE}</Number>
    </Dial>
</Response>`);
});

// API - recent call history
app.get('/api/calls', (req, res) => {
  const calls = recentCalls.all();
  res.json(calls);
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
  console.log(`===========================\n`);
});
