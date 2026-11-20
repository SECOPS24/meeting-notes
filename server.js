'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'meetings.json');

const LIMITS = {
  title: 200,
  notes: 20000,
  attendees: 100,
  attendeeName: 100,
  actionItems: 200,
  actionText: 500,
};

// ---------------------------------------------------------------------------
// Store: in-memory, mirrored to a JSON file so data survives a restart.
// On FUSE the container filesystem is ephemeral — swap this module for a
// database before relying on the data in production.
// ---------------------------------------------------------------------------
let meetings = [];

function loadStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (Array.isArray(parsed)) meetings = parsed;
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('Could not read data file, starting empty:', err.message);
  }
}

function saveStore() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${DATA_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(meetings, null, 2));
    fs.renameSync(tmp, DATA_FILE);
  } catch (err) {
    // Keep serving from memory if the disk is not writable.
    console.error('Could not persist data file:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
function isIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function cleanString(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/** Returns { value } with a normalised meeting payload, or { error }. */
function parseMeeting(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Request body must be a JSON object.' };
  }

  const title = cleanString(body.title, LIMITS.title);
  if (!title) return { error: 'Title is required.' };

  if (!isIsoDate(body.date)) return { error: 'Date is required, in YYYY-MM-DD format.' };

  const rawAttendees = body.attendees === undefined ? [] : body.attendees;
  if (!Array.isArray(rawAttendees)) return { error: 'Attendees must be a list of names.' };
  if (rawAttendees.length > LIMITS.attendees) return { error: `At most ${LIMITS.attendees} attendees.` };
  const seen = new Set();
  const attendees = [];
  for (const raw of rawAttendees) {
    const name = cleanString(raw, LIMITS.attendeeName);
    const key = name.toLowerCase();
    if (name && !seen.has(key)) {
      seen.add(key);
      attendees.push(name);
    }
  }

  const rawItems = body.actionItems === undefined ? [] : body.actionItems;
  if (!Array.isArray(rawItems)) return { error: 'Action items must be a list.' };
  if (rawItems.length > LIMITS.actionItems) return { error: `At most ${LIMITS.actionItems} action items.` };
  const actionItems = [];
  for (const raw of rawItems) {
    if (!raw || typeof raw !== 'object') return { error: 'Each action item must be an object.' };
    const text = cleanString(raw.text, LIMITS.actionText);
    if (!text) continue; // silently drop blank rows
    const dueDate = raw.dueDate === undefined || raw.dueDate === null || raw.dueDate === '' ? null : raw.dueDate;
    if (dueDate !== null && !isIsoDate(dueDate)) {
      return { error: `Due date for "${text.slice(0, 40)}" must be in YYYY-MM-DD format.` };
    }
    actionItems.push({
      id: typeof raw.id === 'string' && /^[0-9a-f-]{36}$/.test(raw.id) ? raw.id : crypto.randomUUID(),
      text,
      owner: cleanString(raw.owner, LIMITS.attendeeName),
      dueDate,
      done: raw.done === true,
    });
  }

  return {
    value: {
      title,
      date: body.date,
      attendees,
      notes: typeof body.notes === 'string' ? body.notes.slice(0, LIMITS.notes) : '',
      actionItems,
    },
  };
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
  );
  next();
});

// Health check: no I/O, no auth, always 200.
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.get('/favicon.ico', (req, res) => res.status(204).end());

app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public'))); // serves GET / -> index.html

const byNewest = (a, b) => b.date.localeCompare(a.date) || b.updatedAt.localeCompare(a.updatedAt);

app.get('/api/meetings', (req, res) => {
  res.json([...meetings].sort(byNewest));
});

app.get('/api/meetings/:id', (req, res) => {
  const meeting = meetings.find((m) => m.id === req.params.id);
  if (!meeting) return res.status(404).json({ error: 'Meeting not found.' });
  res.json(meeting);
});

app.post('/api/meetings', (req, res) => {
  const { value, error } = parseMeeting(req.body);
  if (error) return res.status(400).json({ error });
  const now = new Date().toISOString();
  const meeting = { id: crypto.randomUUID(), ...value, createdAt: now, updatedAt: now };
  meetings.push(meeting);
  saveStore();
  res.status(201).json(meeting);
});

app.put('/api/meetings/:id', (req, res) => {
  const index = meetings.findIndex((m) => m.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Meeting not found.' });
  const { value, error } = parseMeeting(req.body);
  if (error) return res.status(400).json({ error });
  const existing = meetings[index];
  meetings[index] = { id: existing.id, ...value, createdAt: existing.createdAt, updatedAt: new Date().toISOString() };
  saveStore();
  res.json(meetings[index]);
});

app.delete('/api/meetings/:id', (req, res) => {
  const index = meetings.findIndex((m) => m.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Meeting not found.' });
  meetings.splice(index, 1);
  saveStore();
  res.status(204).end();
});

// Tick an action item on or off without re-sending the whole meeting.
app.patch('/api/meetings/:id/action-items/:itemId', (req, res) => {
  const meeting = meetings.find((m) => m.id === req.params.id);
  const item = meeting && meeting.actionItems.find((a) => a.id === req.params.itemId);
  if (!item) return res.status(404).json({ error: 'Action item not found.' });
  if (!req.body || typeof req.body.done !== 'boolean') {
    return res.status(400).json({ error: '"done" must be true or false.' });
  }
  item.done = req.body.done;
  meeting.updatedAt = new Date().toISOString();
  saveStore();
  res.json(meeting);
});

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found.' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON.' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request is too large.' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong.' });
});

loadStore();

if (require.main === module) {
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Meeting Notes listening on 0.0.0.0:${PORT}`);
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = app;
