// Unit tests for usage.js (all data here is invented).
const test = require('node:test');
const assert = require('node:assert');
const usage = require('../usage');

const rec = (id, model, u, ts = '2026-11-04T10:00:00Z', extra = {}) => ({
  type: 'assistant', requestId: `req_${id}`, timestamp: ts, ...extra,
  message: { id: `msg_${id}`, model, usage: u },
});
const U = (o) => ({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...o });

test('counts each message once and splits cache writes by TTL', () => {
  const c = usage.createCollector();
  const u = U({ input_tokens: 100, output_tokens: 1000, cache_read_input_tokens: 50000, cache_creation_input_tokens: 3000, cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 2000 } });
  c.add(rec('a', 'claude-opus-5-5', u));
  c.add(rec('a', 'claude-opus-5-5', u)); // same message written again for another content block
  c.add(rec('b', '<synthetic>', U({ output_tokens: 99 })));
  const day = Object.keys(c.days)[0];
  assert.deepStrictEqual(c.days[day]['claude-opus-5-5'], { input: 100, output: 1000, cacheRead: 50000, cacheWrite5m: 1000, cacheWrite1h: 2000, requests: 1 });
  assert.strictEqual(Object.keys(c.days[day]).length, 1);
});

test('cost uses per-model prices, cache multipliers and fast mode', () => {
  const t = { input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite5m: 1e6, cacheWrite1h: 1e6 };
  // Opus 5.5: 4 + 20 + 0.2 + 5 + 8
  assert.strictEqual(Math.round(usage.costOf(t, usage.priceFor('claude-opus-5-5')) * 100) / 100, 37.2);
  assert.strictEqual(Math.round(usage.costOf(t, usage.priceFor('claude-opus-5-5:fast')) * 100) / 100, 74.4);
  assert.deepStrictEqual(usage.priceFor('claude-haiku-4-5-20251001'), usage.priceFor('claude-haiku-4-5'));
  assert.strictEqual(usage.priceFor('claude-unknown-9'), null);
  assert.strictEqual(usage.priceFor('claude-unknown-9', { 'claude-unknown-9': { input: 1, output: 2, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2 } }).output, 2);
  assert.strictEqual(usage.priceFor('claude-opus-5-5', { 'claude-opus-5-5': { output: 30 } }).output, 30); // partial override
});

test('summarize filters by day and reports unpriced models', () => {
  const c = usage.createCollector();
  c.add(rec('a', 'claude-sonnet-5-5', U({ output_tokens: 1e6 }), '2026-11-03T12:00:00'));
  c.add(rec('b', 'claude-sonnet-5-5', U({ output_tokens: 2e6 }), '2026-11-04T12:00:00'));
  c.add(rec('c', 'claude-mystery', U({ output_tokens: 5 }), '2026-11-04T13:00:00'));
  const all = usage.summarize([c.days]);
  assert.strictEqual(all.output, 3e6 + 5);
  assert.strictEqual(all.cost, 30);
  assert.deepStrictEqual(all.unpriced, ['claude-mystery']);
  const one = usage.summarize([c.days], { fromKey: '2026-11-04', toKey: '2026-11-04' });
  assert.strictEqual(one.cost, 20);
  assert.strictEqual(one.requests, 2);
});

test('formatting', () => {
  assert.strictEqual(usage.formatTokens(950), '950');
  assert.strictEqual(usage.formatTokens(1234), '1.2K');
  assert.strictEqual(usage.formatTokens(45000000), '45M');
  assert.strictEqual(usage.formatCost(0.004), '<$0.01');
  assert.strictEqual(usage.formatCost(12.345), '$12.35');
  assert.strictEqual(usage.formatCost(1234.5), '$1,235');
});

test('report lists totals, models, projects and sessions', () => {
  const c = usage.createCollector();
  c.add(rec('a', 'claude-opus-5-5', U({ output_tokens: 1e6 }), '2026-11-04T10:00:00'));
  const md = usage.buildReport([{ title: 'dark-mode-toggle', cwd: '/projects/my-web-app', usage: c.days }], { label: 'Test' });
  assert.match(md, /\*\*≈ \$20\.00\*\*/);
  assert.match(md, /\| `claude-opus-5-5` \| \$20\.00 \|/);
  assert.match(md, /\| my-web-app \| \$20\.00 \| 1 \|/);
  assert.match(md, /\| dark-mode-toggle \| my-web-app \| \$20\.00 \|/);
  assert.match(usage.buildReport([], { label: 'Empty' }), /No Claude Code usage/);
});
