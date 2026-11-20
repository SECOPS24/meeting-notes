'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-notes-'));
const app = require('../server');

let server;
let base;

before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});

const call = async (method, url, body) => {
  const res = await fetch(base + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text };
};

test('health and index respond 200', async () => {
  const health = await call('GET', '/health');
  assert.equal(health.status, 200);
  assert.deepEqual(health.body, { status: 'ok' });
  assert.equal((await call('GET', '/')).status, 200);
});

test('create, read, update, toggle and delete a meeting', async () => {
  const created = await call('POST', '/api/meetings', {
    title: '  Weekly sync ',
    date: '2026-11-19',
    attendees: ['Asha', 'asha', ' Ben '],
    notes: 'Discussed rollout.',
    actionItems: [
      { text: 'Draft rollout plan', owner: 'Asha', dueDate: '2026-11-26' },
      { text: '   ' },
    ],
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.title, 'Weekly sync');
  assert.deepEqual(created.body.attendees, ['Asha', 'Ben']);
  assert.equal(created.body.actionItems.length, 1);
  const { id } = created.body;
  const item = created.body.actionItems[0];
  assert.equal(item.done, false);

  const list = await call('GET', '/api/meetings');
  assert.equal(list.body.length, 1);

  const updated = await call('PUT', `/api/meetings/${id}`, {
    ...created.body,
    actionItems: [...created.body.actionItems, { text: 'Book room', owner: '', dueDate: null }],
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.actionItems.length, 2);
  assert.equal(updated.body.actionItems[0].id, item.id, 'existing item ids are preserved');

  const toggled = await call('PATCH', `/api/meetings/${id}/action-items/${item.id}`, { done: true });
  assert.equal(toggled.body.actionItems[0].done, true);

  const saved = JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, 'meetings.json'), 'utf8'));
  assert.equal(saved[0].actionItems[0].done, true, 'changes are persisted to disk');

  assert.equal((await call('DELETE', `/api/meetings/${id}`)).status, 204);
  assert.equal((await call('GET', `/api/meetings/${id}`)).status, 404);
});

test('rejects invalid input', async () => {
  assert.equal((await call('POST', '/api/meetings', { date: '2026-11-19' })).status, 400);
  assert.equal((await call('POST', '/api/meetings', { title: 'x', date: '2026-02-30' })).status, 400);
  const badDue = await call('POST', '/api/meetings', {
    title: 'x', date: '2026-11-19', actionItems: [{ text: 'y', dueDate: 'tomorrow' }],
  });
  assert.equal(badDue.status, 400);
  assert.equal((await call('PATCH', '/api/meetings/nope/action-items/nope', { done: true })).status, 404);
  assert.equal((await call('GET', '/api/unknown')).status, 404);
});
