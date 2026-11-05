// Unit tests for share.js (run with: npm test)
const test = require('node:test');
const assert = require('node:assert');
const share = require('../share');

// Fake secrets are assembled at runtime so this file never contains a real-looking token.
const fake = (prefix, n, ch = 'a') => prefix + ch.repeat(n);
const GH_PAT = fake('github_pat_', 60, 'A1');
const AWS_KEY = 'AKIA' + 'ABCDEFGHIJKLMNOP';

test('redact removes common token formats', () => {
  const text = [
    `token ${GH_PAT}`,
    `key ${AWS_KEY}`,
    `slack ${fake('xoxb-', 30, '1')}`,
    `url https://user:${fake('', 12, 'p')}@example.com/db`,
    `export DB_PASSWORD=${fake('S3cr', 10, 't')}`,
    `Authorization: Bearer ${fake('', 40, 'b')}`,
  ].join('\n');
  const r = share.redact(text);
  assert.ok(!r.text.includes(GH_PAT), 'GitHub token');
  assert.ok(!r.text.includes(AWS_KEY), 'AWS key');
  assert.ok(!/xoxb-1{10}/.test(r.text), 'Slack token');
  assert.ok(!r.text.includes('p'.repeat(12)), 'password in URL');
  assert.ok(r.text.includes('DB_PASSWORD=[REDACTED]'), 'secret assignment');
  assert.ok(r.text.includes('Bearer [REDACTED]'), 'bearer');
  assert.ok(r.total >= 6);
});

test('redact leaves ordinary values alone', () => {
  const text = [
    'maxTokens: 4096',
    'cacheReadInputTokens=181217',
    'password: ${DB_PASSWORD}',
    'apiKey = process.env.API_KEY',
    'token: string',
    'const secret = true',
  ].join('\n');
  const r = share.redact(text);
  assert.strictEqual(r.text, text);
  assert.strictEqual(r.total, 0);
});

test('redactJsonl keeps every line valid JSON and drops internal logs', () => {
  const lines = [
    { type: 'user', message: { role: 'user', content: `here is my token ${GH_PAT}` } },
    { type: 'assistant', usage: { cacheReadInputTokens: 181217 }, message: { content: [{ type: 'text', text: 'ok' }] } },
    { type: 'user', toolUseResult: { stdout: 'DB_PASSWORD="hunter2hunter2"\nother' } },
    { type: 'api-request', params: { hostCredential: 'x'.repeat(40) } },
    { type: 'attachment', env: { CLIENT_SECRET: 'abc123def456ghi' } },
  ];
  const r = share.redactJsonl(lines.map((l) => JSON.stringify(l)).join('\n'));
  const out = r.text.trim().split('\n').map((l) => JSON.parse(l)); // throws if invalid
  assert.strictEqual(out.length, 4, 'api-request dropped');
  assert.strictEqual(r.dropped, 1);
  assert.ok(!r.text.includes(GH_PAT));
  assert.strictEqual(out[1].usage.cacheReadInputTokens, 181217, 'numbers untouched');
  assert.ok(out[2].toolUseResult.stdout.includes('[REDACTED]'));
  assert.strictEqual(out[3].env.CLIENT_SECRET, '[REDACTED]', 'secret-named key');
});

test('projectDirFor matches Claude Code folder naming', () => {
  const p = require('path');
  assert.strictEqual(p.basename(share.projectDirFor('/Users/me/my.app/web-ui')), '-Users-me-my-app-web-ui');
});

test('rewriteTranscript moves cwd and session ID', () => {
  const oldId = '11111111-1111-4111-8111-111111111111';
  const newId = '22222222-2222-4222-8222-222222222222';
  const jsonl = [
    { type: 'user', cwd: '/home/a/proj', sessionId: oldId },
    { type: 'user', cwd: '/home/a/proj/sub', sessionId: oldId },
    { type: 'attachment', attachment: { snapshot: { workingDirectory: '/home/a/proj' } }, sessionId: oldId },
    { type: 'user', cwd: '/home/a/projector', sessionId: oldId },
  ].map((l) => JSON.stringify(l)).join('\n') + '\nnot json\n';
  const out = share.rewriteTranscript(jsonl, { oldCwd: '/home/a/proj', newCwd: '/Users/b/proj', oldId, newId }).trim().split('\n');
  const o = out.slice(0, 4).map((l) => JSON.parse(l));
  assert.strictEqual(o[0].cwd, '/Users/b/proj');
  assert.strictEqual(o[1].cwd, '/Users/b/proj/sub');
  assert.strictEqual(o[2].attachment.snapshot.workingDirectory, '/Users/b/proj');
  assert.strictEqual(o[3].cwd, '/home/a/projector', 'only exact path prefixes are rewritten');
  assert.ok(o.every((x) => x.sessionId === newId));
  assert.strictEqual(out[4], 'not json', 'unparseable lines kept');
});

test('readBundle rejects files that are not exports', () => {
  const fs = require('fs');
  const os = require('os');
  const p = require('path');
  const f = p.join(fs.mkdtempSync(p.join(os.tmpdir(), 'cts-')), 'x.json');
  fs.writeFileSync(f, JSON.stringify({ hello: 'world' }));
  assert.throws(() => share.readBundle(f), /not a Claude Terminal Sessions export/);
  fs.writeFileSync(f, '{oops');
  assert.throws(() => share.readBundle(f), /Not a valid session export/);
});
