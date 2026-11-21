// Unit tests for diffs.js (all data here is invented).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const diffs = require('../diffs');

const edit = (file, old_string, new_string, extra = {}) => ({ file, tool: 'Edit', input: { file_path: file, old_string, new_string, ...extra } });
const write = (file, content) => ({ file, tool: 'Write', input: { file_path: file, content } });

test('applyEdit and undoEdit', () => {
  const e = edit('/p/a.ts', 'light', 'dark');
  assert.strictEqual(diffs.applyEdit('theme = light; other = light', e), 'theme = dark; other = light');
  assert.strictEqual(diffs.applyEdit('theme = light; other = light', edit('/p/a.ts', 'light', 'dark', { replace_all: true })), 'theme = dark; other = dark');
  assert.strictEqual(diffs.applyEdit('nothing here', e), null);
  assert.strictEqual(diffs.applyEdit('x', write('/p/a.ts', 'new content')), 'new content');
  assert.strictEqual(diffs.undoEdit('theme = dark', e), 'theme = light');
  assert.strictEqual(diffs.undoEdit('x', write('/p/a.ts', 'y')), null);
  const multi = { file: '/p/a.ts', tool: 'MultiEdit', input: { file_path: '/p/a.ts', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd' }] } };
  assert.strictEqual(diffs.applyEdit('a c', multi), 'b d');
  assert.strictEqual(diffs.undoEdit('b d', multi), 'a c');
  assert.strictEqual(diffs.applyEdit('$1 money', edit('/p/a.ts', 'money', '$& cash')), '$1 $& cash'); // no regex replacement patterns
});

test('lineStats counts added and removed lines', () => {
  assert.deepStrictEqual(diffs.lineStats('a\nb\nc', 'a\nB\nc\nd'), { added: 2, removed: 1 });
  assert.deepStrictEqual(diffs.lineStats('', 'x\ny'), { added: 2, removed: 0 });
  assert.deepStrictEqual(diffs.lineStats('same', 'same'), { added: 0, removed: 0 });
});

test('fileChange: before from the backup, after by replaying the edits', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cts-diff-'));
  fs.writeFileSync(path.join(dir, 'abc123@v1'), 'export const theme = "light";\nexport const size = 1;\n');
  const file = path.join(dir, 'theme.ts');
  const c = diffs.fileChange(file, [edit(file, '"light"', '"dark"'), edit(file, 'size = 1', 'size = 2')], { hash: 'abc123', existed: true }, dir);
  assert.strictEqual(c.mode, 'exact');
  assert.strictEqual(c.after, 'export const theme = "dark";\nexport const size = 2;\n');
  assert.deepStrictEqual([c.added, c.removed], [2, 2]);
  assert.strictEqual(c.created, false);
});

test('fileChange: created files, approximate replays and changed parts only', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cts-diff-'));
  const file = path.join(dir, 'ThemeToggle.tsx');
  // Created with Write: backups start at version 2, so there is no version 1.
  const created = diffs.fileChange(file, [write(file, 'line 1\nline 2'), edit(file, 'line 2', 'line two')], { hash: 'def456', existed: true }, dir);
  assert.strictEqual(created.created, true);
  assert.strictEqual(created.before, '');
  assert.strictEqual(created.after, 'line 1\nline two');
  // An edit that no longer applies (the file was also changed another way): approximate.
  fs.writeFileSync(path.join(dir, 'aaa@v1'), 'alpha\nbeta\n');
  const approx = diffs.fileChange(file, [edit(file, 'beta', 'BETA'), edit(file, 'gamma', 'GAMMA')], { hash: 'aaa', existed: true }, dir);
  assert.strictEqual(approx.mode, 'approximate');
  assert.strictEqual(approx.after, 'alpha\nBETA\n');
  // No backup and the current file doesn't contain the edits: only the changed parts.
  fs.writeFileSync(file, 'unrelated content');
  const parts = diffs.fileChange(file, [edit(file, 'old text', 'new text')], undefined, dir);
  assert.strictEqual(parts.mode, 'parts');
  assert.match(parts.before, /old text/);
  assert.match(parts.after, /new text/);
  // No backup, but the current file still has the edit: rebuilt by undoing it.
  fs.writeFileSync(file, 'const x = "new text";');
  const rebuilt = diffs.fileChange(file, [edit(file, '"old text"', '"new text"')], undefined, dir);
  assert.strictEqual(rebuilt.mode, 'exact');
  assert.strictEqual(rebuilt.before, 'const x = "old text";');
});

test('collect reads edits from the session and its agents, and backups from snapshots', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cts-collect-'));
  const sess = path.join(root, 's1.jsonl');
  const tool = (ts, name, input) => JSON.stringify({ type: 'assistant', timestamp: ts, message: { content: [{ type: 'tool_use', name, input }] } });
  fs.writeFileSync(sess, [
    JSON.stringify({ type: 'file-history-snapshot', snapshot: { trackedFileBackups: { 'src/theme.ts': { backupFileName: 'abc@v1', version: 1 } } } }),
    tool('2026-11-04T10:00:00Z', 'Edit', { file_path: '/projects/my-web-app/src/theme.ts', old_string: 'a', new_string: 'b' }),
  ].join('\n'));
  fs.mkdirSync(path.join(root, 's1', 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(root, 's1', 'subagents', 'agent-x.jsonl'), tool('2026-11-04T09:00:00Z', 'Write', { file_path: '/projects/my-web-app/README.md', content: 'hi' }));
  const { edits, backups } = diffs.collect(sess, 's1', '/projects/my-web-app');
  assert.deepStrictEqual(edits.map((e) => e.tool), ['Write', 'Edit']); // sorted by time across session and agents
  assert.deepStrictEqual(backups.get(path.join('/projects/my-web-app', 'src/theme.ts')), { hash: 'abc', existed: true });
});
