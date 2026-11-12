// Subagents (Agent / Task tool) of a session. Pure Node (no vscode dependency).
//
// Claude Code keeps each agent next to its session:
//   <project>/<sessionId>/subagents/agent-<id>.jsonl      the agent's own conversation
//   <project>/<sessionId>/subagents/agent-<id>.meta.json  { agentType, description, model, requestShape, finished, ... }
const fs = require('fs');
const path = require('path');
const usage = require('./usage');

function agentsDir(sessionFile, sessionId) {
  return path.join(path.dirname(sessionFile), sessionId, 'subagents');
}

// All agents of a session, oldest first. Cheap: reads only the small .meta.json files and stats.
function listAgents(sessionFile, sessionId) {
  const dir = agentsDir(sessionFile, sessionId);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!n.endsWith('.meta.json')) continue;
    const id = n.slice(0, -'.meta.json'.length);
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); } catch { continue; }
    const file = path.join(dir, `${id}.jsonl`);
    let st = null;
    try { st = fs.statSync(file); } catch { /* not written yet */ }
    out.push({
      id,
      file,
      type: meta.agentType || 'agent',
      description: meta.description || id,
      model: meta.model || meta.pickedEffortModel || '',
      background: meta.requestShape === 'background',
      finished: meta.finished === true,
      started: st ? st.birthtime : null,
      lastWrite: st ? st.mtime : null,
      size: st ? st.size : 0,
    });
  }
  return out.sort((a, b) => (a.started || 0) - (b.started || 0));
}

// running: not finished and its session is still open. stopped: the session ended first.
function status(agent, sessionRunning) {
  if (agent.finished) return 'done';
  return sessionRunning ? 'running' : 'stopped';
}

const STATUS_LABEL = { running: 'Running', done: 'Done', stopped: 'Stopped' };

// Short description of a tool call: "Bash: npm test", "Edit ThemeToggle.tsx".
function describeTool(name, input = {}) {
  const one = (s, n = 70) => {
    const t = String(s).replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n - 1) + '…' : t;
  };
  if (name === 'Bash' && input.command) return `${input.description ? one(input.description, 50) : `Bash: ${one(input.command)}`}`;
  const p = input.file_path || input.notebook_path;
  if (p) return `${name} ${path.basename(p)}`;
  const hint = input.pattern || input.query || input.url || input.description || '';
  return hint ? `${name}: ${one(hint, 50)}` : name;
}

const activityCache = new Map(); // file -> { size, mtimeMs, data }

// Details from an agent's transcript: its task, tool calls, last action, final answer and tokens.
function agentActivity(agent) {
  let st;
  try { st = fs.statSync(agent.file); } catch { return null; }
  const c = activityCache.get(agent.file);
  if (c && c.size === st.size && c.mtimeMs === st.mtimeMs) return c.data;
  let raw = '';
  try { raw = fs.readFileSync(agent.file, 'utf8'); } catch { return null; }
  const col = usage.createCollector();
  const data = { prompt: '', started: null, last: null, toolCalls: 0, lastAction: '', lastActionTime: null, result: '', usage: null };
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const t = o.timestamp ? new Date(o.timestamp) : null;
    if (t && !isNaN(t)) {
      if (!data.started || t < data.started) data.started = t;
      if (!data.last || t > data.last) data.last = t;
    }
    const m = o.message;
    if (!m) continue;
    if (o.type === 'user' && !data.prompt) {
      const text = typeof m.content === 'string' ? m.content
        : Array.isArray(m.content) ? (m.content.find((b) => b && b.type === 'text') || {}).text || '' : '';
      if (text) data.prompt = text.trim();
    }
    if (o.type === 'assistant') {
      col.add(o);
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (!b) continue;
        if (b.type === 'tool_use' && b.name === 'SubagentHandback') {
          // How agents return their answer to the main session.
          if (b.input && typeof b.input.message === 'string') data.result = b.input.message.trim();
        } else if (b.type === 'tool_use') {
          data.toolCalls++;
          data.lastAction = describeTool(b.name, b.input || {});
          data.lastActionTime = t;
        } else if (b.type === 'text' && b.text && b.text.trim()) {
          data.result = b.text.trim();
        }
      }
    }
  }
  data.usage = col.days;
  activityCache.set(agent.file, { size: st.size, mtimeMs: st.mtimeMs, data });
  return data;
}

function duration(from, to) {
  if (!from || !to) return '';
  const s = Math.max(0, Math.round((to - from) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60 ? `${s % 60}s` : ''}`.trim();
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

module.exports = { agentsDir, listAgents, status, STATUS_LABEL, describeTool, agentActivity, duration };
