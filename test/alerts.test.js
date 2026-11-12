// Unit tests for notify.js and the context-window helper (all data here is invented).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const notify = require('../notify');
const usage = require('../usage');

const entry = (id, status, extra = {}) => [id, { sessionId: id, pid: 100, status, updatedAt: 1, ...extra }];

test('newlyWaiting reports sessions that just started waiting', () => {
  const prev = new Map([entry('a', 'busy'), entry('b', 'waiting', { waitingFor: 'permission' }), entry('c', 'idle')]);
  const next = new Map([
    entry('a', 'waiting', { waitingFor: 'permission to run npm test', updatedAt: 2 }), // busy -> waiting
    entry('b', 'waiting', { waitingFor: 'permission' }), // still the same question
    entry('c', 'busy'),
    entry('d', 'waiting', { updatedAt: 5 }), // new session already waiting
  ]);
  assert.deepStrictEqual(notify.newlyWaiting(prev, next).map((e) => e.sessionId), ['a', 'd']);
  // a different question while still waiting counts again
  const again = new Map([entry('b', 'waiting', { waitingFor: 'permission to edit App.tsx', updatedAt: 9 })]);
  assert.deepStrictEqual(notify.newlyWaiting(prev, again).map((e) => e.sessionId), ['b']);
});

test('newlyFinished reports each agent once and ignores old ones', () => {
  const known = new Map();
  const since = Date.parse('2026-11-12T10:00:00Z');
  const before = new Date(since - 60000);
  const after = new Date(since + 60000);
  // first look: an old finished agent and a running one -> nothing to report
  assert.deepStrictEqual(notify.newlyFinished(known, 's1', [
    { id: 'old', finished: true, lastWrite: before },
    { id: 'run', finished: false, lastWrite: after },
  ], since), []);
  // the running one finishes, and a quick new one appears already finished
  const done = notify.newlyFinished(known, 's1', [
    { id: 'old', finished: true, lastWrite: before },
    { id: 'run', finished: true, lastWrite: after },
    { id: 'quick', finished: true, lastWrite: after },
  ], since);
  assert.deepStrictEqual(done.map((a) => a.id), ['run', 'quick']);
  // nothing new the next time
  assert.deepStrictEqual(notify.newlyFinished(known, 's1', [{ id: 'run', finished: true, lastWrite: after }], since), []);
});

test('claimOnce lets only the first window alert', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cts-alerts-'));
  assert.strictEqual(notify.claimOnce('wait|s1|1|q', dir), true);
  assert.strictEqual(notify.claimOnce('wait|s1|1|q', dir), false);
  assert.strictEqual(notify.claimOnce('wait|s1|2|q', dir), true);
  const old = path.join(dir, fs.readdirSync(dir)[0]);
  fs.utimesSync(old, new Date(0), new Date(0));
  notify.cleanMarkers(1000, dir);
  assert.strictEqual(fs.readdirSync(dir).length, 1);
});

test('contextWindow per model', () => {
  assert.strictEqual(usage.contextWindow('claude-opus-5-5'), 1000000);
  assert.strictEqual(usage.contextWindow('claude-sonnet-5-5:fast'), 1000000);
  assert.strictEqual(usage.contextWindow('claude-haiku-4-5-20251001'), 200000);
  assert.strictEqual(usage.contextWindow('claude-unknown'), null);
});
