// Unit tests for shell.js, the Windows-related parts of running.js/share.js/paths.js, and session names.
const test = require('node:test');
const assert = require('node:assert');
const shell = require('../shell');
const running = require('../running');
const share = require('../share');
const marks = require('../marks');

test('shellKind picks the syntax from the default terminal shell', () => {
  assert.strictEqual(shell.shellKind('win32', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'), 'powershell');
  assert.strictEqual(shell.shellKind('win32', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'), 'powershell');
  assert.strictEqual(shell.shellKind('win32', 'C:\\Windows\\System32\\cmd.exe'), 'cmd');
  assert.strictEqual(shell.shellKind('win32', 'C:\\Program Files\\Git\\bin\\bash.exe'), 'posix');
  assert.strictEqual(shell.shellKind('win32', ''), 'powershell');
  assert.strictEqual(shell.shellKind('darwin', '/bin/zsh'), 'posix');
  assert.strictEqual(shell.shellKind('linux', '/usr/bin/fish'), 'fish');
  assert.strictEqual(shell.shellKind('linux', undefined), 'posix');
});

test('cdAndRun quotes folders for each shell', () => {
  const cmd = 'claude --resume 1234';
  assert.strictEqual(shell.cdAndRun('posix', "/projects/it's here", cmd), `cd '/projects/it'\\''s here' && ${cmd}`);
  assert.strictEqual(shell.cdAndRun('powershell', "C:\\Users\\me\\it's app", cmd), `Set-Location -LiteralPath 'C:\\Users\\me\\it''s app'; ${cmd}`);
  assert.strictEqual(shell.cdAndRun('cmd', 'C:\\Users\\me\\my app', cmd), `cd /d "C:\\Users\\me\\my app" && ${cmd}`);
  assert.strictEqual(shell.cdAndRun('fish', "/projects/it's", cmd), `cd '/projects/it\\'s' && ${cmd}`);
});

test('ancestorPids finds this process\'s parent on the current OS', () => {
  const parents = running.ancestorPids(process.pid, 2);
  assert.ok(parents.length >= 1, `expected a parent, got ${JSON.stringify(parents)}`);
  assert.ok(parents.includes(process.ppid), `expected ${process.ppid} in ${JSON.stringify(parents)}`);
  assert.deepStrictEqual(running.ancestorPids('nope'), []);
});

test('import rewrites paths with the new computer\'s separator', () => {
  const jsonl = [
    JSON.stringify({ type: 'user', cwd: '/Users/a/proj', sessionId: 'old' }),
    JSON.stringify({ type: 'user', cwd: '/Users/a/proj/src/app', sessionId: 'old' }),
  ].join('\n') + '\n';
  const out = share.rewriteTranscript(jsonl, { oldCwd: '/Users/a/proj', newCwd: 'C:\\Users\\b\\proj', oldId: 'old', newId: 'new' })
    .trim().split('\n').map((l) => JSON.parse(l));
  assert.strictEqual(out[0].cwd, 'C:\\Users\\b\\proj');
  assert.strictEqual(out[1].cwd, 'C:\\Users\\b\\proj\\src\\app');
  const back = share.rewriteTranscript(JSON.stringify({ type: 'user', cwd: 'C:\\Users\\b\\proj\\src', sessionId: 'x' }) + '\n',
    { oldCwd: 'C:\\Users\\b\\proj', newCwd: '/home/c/proj', oldId: 'x', newId: 'y' });
  assert.strictEqual(JSON.parse(back.trim()).cwd, '/home/c/proj/src');
});

test('relativeIn accepts either separator', () => {
  const { relativeIn } = require('../summary');
  assert.strictEqual(relativeIn('/projects/app', '/projects/app/src/App.tsx'), 'src/App.tsx');
  assert.strictEqual(relativeIn('C:\\Users\\me\\app', 'C:\\Users\\me\\app\\src\\App.tsx'), 'src\\App.tsx');
  assert.strictEqual(relativeIn('C:\\Users\\me\\app', 'c:\\users\\me\\app/src/App.tsx'), 'src/App.tsx'); // Windows paths ignore case
  assert.strictEqual(relativeIn('/projects/app', '/projects/application/x.ts'), null);
  assert.strictEqual(relativeIn('/projects/app', '/projects/app'), null);
});

test('projectDirFor encodes Windows paths like Claude Code', () => {
  const path = require('path');
  assert.strictEqual(path.basename(share.projectDirFor('C:\\Users\\me\\my-app')), 'C--Users-me-my-app');
});

test('session names are kept, matched by the filter and cleared when empty', () => {
  let m = marks.update({}, 'a1', { name: 'Login bug, part 2' });
  assert.deepStrictEqual(m, { a1: { name: 'Login bug, part 2' } });
  const s = { id: 'a1', title: 'Login bug, part 2', baseTitle: 'fix-login-redirect', cwd: '/projects/api-server' };
  assert.ok(marks.matchesFilter(s, m.a1, 'part 2'));
  assert.ok(marks.matchesFilter(s, m.a1, 'fix-login')); // Claude's title still matches
  m = marks.update(m, 'a1', { name: null });
  assert.deepStrictEqual(m, {});
});
