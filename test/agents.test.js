// Unit tests for agents.js (all data here is invented).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const agents = require('../agents');

function fakeSession() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cts-agents-'));
  const file = path.join(root, 'sess-1.jsonl');
  fs.writeFileSync(file, '');
  const dir = path.join(root, 'sess-1', 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  const add = (id, meta, records = []) => {
    fs.writeFileSync(path.join(dir, `${id}.meta.json`), JSON.stringify(meta));
    fs.writeFileSync(path.join(dir, `${id}.jsonl`), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  };
  return { file, dir, add };
}

const rec = (type, content, ts, extra = {}) => ({ type, isSidechain: true, timestamp: ts, message: { role: type, content, ...extra } });

test('listAgents reads metadata and status depends on the session', () => {
  const s = fakeSession();
  s.add('agent-a1', { agentType: 'Explore', description: 'Find theme files', requestShape: 'background', model: 'sonnet', finished: true });
  s.add('agent-b2', { agentType: 'general-purpose', description: 'Write toggle tests', requestShape: 'foreground', finished: false });
  s.add('agent-c3', { agentType: 'general-purpose', description: 'Old run' }); // no finished flag (older Claude Code)
  fs.writeFileSync(path.join(s.dir, 'agent-bad.meta.json'), '{broken');
  const list = agents.listAgents(s.file, 'sess-1');
  assert.deepStrictEqual(list.map((a) => a.id).sort(), ['agent-a1', 'agent-b2', 'agent-c3']);
  const byId = Object.fromEntries(list.map((a) => [a.id, a]));
  assert.strictEqual(byId['agent-a1'].type, 'Explore');
  assert.strictEqual(byId['agent-a1'].background, true);
  assert.strictEqual(agents.status(byId['agent-a1'], true), 'done');
  assert.strictEqual(agents.status(byId['agent-b2'], true), 'running');
  assert.strictEqual(agents.status(byId['agent-b2'], false), 'stopped');
  assert.strictEqual(agents.status(byId['agent-c3'], false), 'stopped');
  assert.deepStrictEqual(agents.listAgents(path.join(os.tmpdir(), 'none.jsonl'), 'nope'), []);
});

test('agentActivity finds the task, last action, result and tokens', () => {
  const s = fakeSession();
  s.add('agent-a1', { agentType: 'general-purpose', description: 'Write toggle tests', finished: true }, [
    rec('user', 'Write unit tests for ThemeToggle.tsx', '2026-11-04T10:00:00Z'),
    rec('assistant', [{ type: 'tool_use', name: 'Read', input: { file_path: '/projects/my-web-app/src/ThemeToggle.tsx' } }], '2026-11-04T10:00:20Z',
      { id: 'm1', model: 'claude-sonnet-5-5', usage: { input_tokens: 10, output_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }),
    rec('assistant', [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test -- ThemeToggle', description: 'Run the toggle tests' } }], '2026-11-04T10:01:00Z',
      { id: 'm2', model: 'claude-sonnet-5-5', usage: { input_tokens: 10, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }),
    rec('assistant', [{ type: 'text', text: 'Added 4 tests; all pass.' }], '2026-11-04T10:02:30Z'),
  ]);
  const [a] = agents.listAgents(s.file, 'sess-1');
  const act = agents.agentActivity(a);
  assert.strictEqual(act.prompt, 'Write unit tests for ThemeToggle.tsx');
  assert.strictEqual(act.toolCalls, 2);
  assert.strictEqual(act.lastAction, 'Run the toggle tests');
  assert.strictEqual(act.result, 'Added 4 tests; all pass.');
  assert.strictEqual(agents.duration(act.started, act.last), '2m 30s');
  const day = Object.keys(act.usage)[0];
  assert.strictEqual(act.usage[day]['claude-sonnet-5-5'].output, 1500);
});

test('the result comes from SubagentHandback when present', () => {
  const s = fakeSession();
  s.add('agent-h1', { agentType: 'Explore', description: 'Find theme files', finished: true }, [
    rec('user', 'Find where the theme is stored', '2026-11-04T10:00:00Z'),
    rec('assistant', [{ type: 'tool_use', name: 'Grep', input: { pattern: 'theme' } }], '2026-11-04T10:00:05Z'),
    rec('assistant', [{ type: 'tool_use', name: 'SubagentHandback', input: { message: 'The theme lives in src/theme.ts.' } }], '2026-11-04T10:00:40Z'),
  ]);
  const act = agents.agentActivity(agents.listAgents(s.file, 'sess-1')[0]);
  assert.strictEqual(act.result, 'The theme lives in src/theme.ts.');
  assert.strictEqual(act.toolCalls, 1); // the hand-back itself is not counted as work
  assert.strictEqual(act.lastAction, 'Grep: theme');
});

test('agents from before the session was resumed show as stopped', () => {
  const s = fakeSession();
  s.add('agent-old', { agentType: 'general-purpose', description: 'Started before VS Code closed' },
    [rec('user', 'Old task', '2026-11-13T12:30:00Z')]);
  s.add('agent-new', { agentType: 'general-purpose', description: 'Started after resuming' },
    [rec('user', 'New task', '2026-11-13T15:40:00Z')]);
  const list = Object.fromEntries(agents.listAgents(s.file, 'sess-1').map((a) => [a.id, a]));
  const resumed = { firstStartedAt: new Date('2026-11-13T15:28:30Z') }; // the new Claude process
  assert.strictEqual(list['agent-old'].firstRecord.toISOString(), '2026-11-13T12:30:00.000Z');
  assert.strictEqual(agents.status(list['agent-old'], resumed), 'stopped');
  assert.strictEqual(agents.status(list['agent-new'], resumed), 'running');
  assert.strictEqual(agents.status(list['agent-new'], null), 'stopped');
  assert.strictEqual(agents.status(list['agent-new'], true), 'running'); // no start time known: trust the session
});

test('describeTool and duration', () => {
  assert.strictEqual(agents.describeTool('Edit', { file_path: '/projects/my-web-app/src/App.tsx' }), 'Edit App.tsx');
  assert.strictEqual(agents.describeTool('Bash', { command: 'git status' }), 'Bash: git status');
  assert.strictEqual(agents.describeTool('Grep', { pattern: 'ThemeToggle' }), 'Grep: ThemeToggle');
  assert.strictEqual(agents.describeTool('TodoWrite', {}), 'TodoWrite');
  assert.strictEqual(agents.duration(new Date(0), new Date(45000)), '45s');
  assert.strictEqual(agents.duration(new Date(0), new Date(3600000 + 120000)), '1h 2m');
  assert.strictEqual(agents.duration(null, new Date()), '');
});
