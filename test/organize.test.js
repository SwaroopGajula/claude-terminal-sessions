// Unit tests for marks.js (pins, notes, labels, archive) and search.js (all data here is invented).
const test = require('node:test');
const assert = require('node:assert');
const marks = require('../marks');
const search = require('../search');

const DAY = 86400000;
const NOW = new Date(2026, 10, 4, 12).getTime();
const session = (o = {}) => ({
  id: 'a1', title: 'dark-mode-toggle', firstPrompt: 'Add a dark mode toggle', lastPrompt: 'Write tests',
  cwd: '/projects/my-web-app', gitBranch: 'feature/dark-mode', updated: new Date(NOW - DAY), ...o,
});

// ---------- marks ----------

test('update merges fields and drops empty entries', () => {
  let m = marks.update({}, 'a1', { pinned: true, note: 'next: tests' });
  assert.deepStrictEqual(m, { a1: { pinned: true, note: 'next: tests' } });
  m = marks.update(m, 'a1', { note: '' });
  assert.deepStrictEqual(m, { a1: { pinned: true } });
  m = marks.update(m, 'a1', { pinned: false, labels: [] });
  assert.deepStrictEqual(m, {});
  assert.deepStrictEqual(marks.remove({ a1: { pinned: true }, b2: { note: 'x' } }, 'a1'), { b2: { note: 'x' } });
});

test('labels are normalized and counted', () => {
  assert.strictEqual(marks.normalizeLabel('  #Bug Fix! '), 'bug-fix');
  assert.strictEqual(marks.normalizeLabel('###'), '');
  const map = { a: { labels: ['bug', 'ui'] }, b: { labels: ['bug'] }, c: { note: 'x' } };
  assert.deepStrictEqual(marks.allLabels(map), ['bug', 'ui']);
});

test('archive: explicit, brought back by new activity, and automatic', () => {
  const s = session();
  assert.ok(!marks.isArchived(s, undefined, { now: NOW }));
  assert.ok(marks.isArchived(s, { archivedAt: NOW }, { now: NOW }));
  // resumed after archiving -> visible again
  assert.ok(!marks.isArchived(session({ updated: new Date(NOW + 1000) }), { archivedAt: NOW }, { now: NOW + 2000 }));
  const old = session({ updated: new Date(NOW - 40 * DAY) });
  assert.ok(marks.isArchived(old, undefined, { autoDays: 30, now: NOW }));
  assert.ok(!marks.isArchived(old, { pinned: true }, { autoDays: 30, now: NOW }));
  assert.ok(!marks.isArchived(old, undefined, { autoDays: 30, hasFollowup: true, now: NOW }));
  assert.ok(!marks.isArchived(old, { unarchivedAt: NOW - DAY }, { autoDays: 30, now: NOW }));
  assert.ok(!marks.isArchived(old, undefined, { autoDays: 0, now: NOW }));
});

test('filter matches text, notes and #labels', () => {
  const s = session();
  const m = { note: 'waiting on design review', labels: ['feature', 'ui'] };
  assert.ok(marks.matchesFilter(s, m, ''));
  assert.ok(marks.matchesFilter(s, m, 'dark'));
  assert.ok(marks.matchesFilter(s, m, 'design review'));
  assert.ok(marks.matchesFilter(s, m, '#feature'));
  assert.ok(marks.matchesFilter(s, m, '#UI my-web-app'));
  assert.ok(!marks.matchesFilter(s, m, '#feat')); // labels match exactly
  assert.ok(!marks.matchesFilter(s, m, '#bug'));
  assert.ok(!marks.matchesFilter(s, undefined, 'design'));
});

// ---------- search ----------

const MD = [
  '# dark-mode-toggle',
  '',
  '- **Folder:** `/projects/my-web-app`',
  '- **Session ID:** `a1`',
  '',
  '',
  '---',
  '## 👤 Prompt 1  ·  Nov 3, 10:00 AM',
  '',
  'Add a dark mode toggle to the header',
  'and remember the choice',
  '',
  '**🤖 Claude:**',
  '',
  'I will add a ThemeToggle component and store the choice in localStorage.',
  '',
  '- ✏️ **Write** `~/projects/my-web-app/src/ThemeToggle.tsx`',
  '- 💻 `npm test -- ThemeToggle` — Run the toggle tests',
  '- 🔧 **Read** `~/projects/my-web-app/src/Header.tsx`',
].join('\n');

test('searchConversation finds prompts, replies, files and commands with line numbers', () => {
  const r = search.searchConversation(MD, 'themetoggle');
  assert.deepStrictEqual(r.matches.map((m) => [m.kind, m.line]), [['reply', 14], ['file', 16], ['command', 17]]);
  assert.strictEqual(r.total, 3);
  assert.deepStrictEqual(search.searchConversation(MD, 'remember choice').matches.map((m) => [m.kind, m.line]), [['prompt', 10]]);
  assert.strictEqual(search.searchConversation(MD, 'my-web-app').matches.some((m) => m.line === 2), false); // header skipped
  assert.strictEqual(search.searchConversation(MD, '').total, 0);
  assert.strictEqual(search.searchConversation(MD, 'toggle', { limit: 1 }).matches.length, 1);
});

test('long lines are clipped around the match', () => {
  const long = `## 👤 Prompt 1\n\n${'x'.repeat(300)} needle ${'y'.repeat(300)}`;
  const [m] = search.searchConversation(long, 'needle').matches;
  assert.match(m.snippet, /^….*needle.*…$/);
  assert.ok(m.snippet.length <= 115);
});

// ---------- paths ----------

test('claudeDir honors CLAUDE_CONFIG_DIR', () => {
  const os = require('os');
  const path = require('path');
  const { claudeDir } = require('../paths');
  assert.strictEqual(claudeDir({}), path.join(os.homedir(), '.claude'));
  assert.strictEqual(claudeDir({ CLAUDE_CONFIG_DIR: '/opt/claude-data' }), '/opt/claude-data');
  assert.strictEqual(claudeDir({ CLAUDE_CONFIG_DIR: '~/alt-claude' }), path.join(os.homedir(), 'alt-claude'));
});
