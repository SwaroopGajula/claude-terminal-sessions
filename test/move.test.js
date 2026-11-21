// Unit tests for move.js. Everything happens in a temporary folder (never the real ~/.claude); data is invented.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const move = require('../move');

const enc = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, '-');

function setup() {
  const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cts-move-'));
  const add = (cwd, id, extraLines = []) => {
    const dir = path.join(claudeDir, 'projects', enc(cwd));
    fs.mkdirSync(path.join(dir, id, 'subagents'), { recursive: true });
    const file = path.join(dir, `${id}.jsonl`);
    fs.writeFileSync(file, [
      JSON.stringify({ type: 'user', cwd, sessionId: id, message: { role: 'user', content: `Fix ${cwd}/src/App.tsx please` } }),
      JSON.stringify({ type: 'assistant', cwd, sessionId: id, message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: `${cwd}/src/App.tsx`, old_string: 'a', new_string: 'b' } }] } }),
      JSON.stringify({ type: 'user', cwd: `${cwd}-other`, sessionId: id }), // a different folder that only starts the same
      ...extraLines,
    ].join('\n') + '\n');
    fs.writeFileSync(path.join(dir, id, 'subagents', 'agent-a1.jsonl'), JSON.stringify({ type: 'user', cwd, isSidechain: true, sessionId: id }) + '\n');
    fs.writeFileSync(path.join(dir, id, 'subagents', 'agent-a1.meta.json'), JSON.stringify({ agentType: 'Explore', finished: true }));
    return { id, file, cwd, title: 'dark-mode-toggle' };
  };
  return { claudeDir, add };
}

test('replacePath only replaces whole path prefixes', () => {
  assert.strictEqual(move.replacePath('/old/app/src/x.ts', '/old/app', '/new/app'), '/new/app/src/x.ts');
  assert.strictEqual(move.replacePath('cd /old/app && npm test', '/old/app', '/new/app'), 'cd /new/app && npm test');
  assert.strictEqual(move.replacePath('/old/app-other/x', '/old/app', '/new/app'), '/old/app-other/x');
  assert.strictEqual(move.replacePath('"/old/app"', '/old/app', '/new/app'), '"/new/app"');
});

test('moveSession moves the transcript and its agents and rewrites paths', () => {
  const { claudeDir, add } = setup();
  const s = add('/projects/my-web-app', 'sess-1');
  const r = move.moveSession(s, '/work/my-web-app', { claudeDir });
  assert.strictEqual(r.id, 'sess-1');
  assert.strictEqual(r.file, path.join(claudeDir, 'projects', enc('/work/my-web-app'), 'sess-1.jsonl'));
  assert.ok(!fs.existsSync(s.file), 'original removed');
  const lines = fs.readFileSync(r.file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.strictEqual(lines[0].cwd, '/work/my-web-app');
  assert.strictEqual(lines[0].message.content, 'Fix /work/my-web-app/src/App.tsx please');
  assert.strictEqual(lines[1].message.content[0].input.file_path, '/work/my-web-app/src/App.tsx');
  assert.strictEqual(lines[2].cwd, '/projects/my-web-app-other', 'other folders are left alone');
  const agent = JSON.parse(fs.readFileSync(path.join(path.dirname(r.file), 'sess-1', 'subagents', 'agent-a1.jsonl'), 'utf8'));
  assert.strictEqual(agent.cwd, '/work/my-web-app');
  assert.ok(fs.existsSync(path.join(path.dirname(r.file), 'sess-1', 'subagents', 'agent-a1.meta.json')));
  assert.throws(() => move.moveSession({ ...s, file: r.file, cwd: '/work/my-web-app' }, '/work/my-web-app', { claudeDir }), /already in that folder/);
});

test('copy keeps the original and gives the copy a new ID and its own backups', () => {
  const { claudeDir, add } = setup();
  const s = add('/projects/my-web-app', 'sess-2');
  fs.mkdirSync(path.join(claudeDir, 'file-history', 'sess-2'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'file-history', 'sess-2', 'abc@v1'), 'old');
  const r = move.moveSession(s, '/work/clone', { claudeDir, copy: true, newId: 'sess-2-copy' });
  assert.ok(fs.existsSync(s.file), 'original kept');
  assert.strictEqual(r.id, 'sess-2-copy');
  const first = JSON.parse(fs.readFileSync(r.file, 'utf8').split('\n')[0]);
  assert.strictEqual(first.sessionId, 'sess-2-copy');
  assert.strictEqual(first.cwd, '/work/clone');
  assert.ok(fs.existsSync(path.join(claudeDir, 'file-history', 'sess-2-copy', 'abc@v1')));
});

test('relink moves every session of a moved folder, including subfolders and project memory', () => {
  const { claudeDir, add } = setup();
  const a = add('/old/repo', 'r1');
  const b = add('/old/repo/packages/api', 'r2');
  const c = add('/elsewhere/app', 'r3');
  const open = add('/old/repo', 'r4');
  fs.mkdirSync(path.join(path.dirname(a.file), 'memory'));
  fs.writeFileSync(path.join(path.dirname(a.file), 'memory', 'MEMORY.md'), '- notes');
  const { moved, failed } = move.relink([a, b, c, open], '/old/repo', '/new/place/repo', (s) => s.id === 'r4', { claudeDir });
  assert.deepStrictEqual(moved.map((m) => [m.id, m.cwd]), [['r1', '/new/place/repo'], ['r2', '/new/place/repo/packages/api']]);
  assert.deepStrictEqual(failed.map((f) => [f.s.id, f.error]), [['r4', 'open in a terminal']]);
  assert.ok(fs.existsSync(c.file), 'unrelated session untouched');
  assert.ok(fs.existsSync(path.join(claudeDir, 'projects', enc('/new/place/repo'), 'memory', 'MEMORY.md')), 'memory carried over');
});

test('missingRoots lists the folder and its missing parents', () => {
  const exists = (p) => ['/', '/old'].includes(p);
  assert.deepStrictEqual(move.missingRoots('/old/repo/sub', exists), ['/old/repo/sub', '/old/repo']);
  assert.deepStrictEqual(move.missingRoots('/old', exists), []);
});
