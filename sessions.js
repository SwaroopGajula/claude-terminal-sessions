// Reading Claude Code sessions from ~/.claude/projects: parsing, details, formatting. No vscode dependency.
const fs = require('fs');
const path = require('path');
const os = require('os');
const usage = require('./usage');

const { CLAUDE_DIR } = require('./paths');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const cache = new Map(); // file -> { mtimeMs, size, session }
let namesState = null; // globalState, for session names given in the sidebar
const setNamesState = (st) => { namesState = st; };
// The conversation view shows how to resume; the shell-specific command comes from the UI layer.
let resumeCommandFor = (s) => `claude --resume ${s.id}`;
const setResumeCommand = (fn) => { resumeCommandFor = fn; };

// ---------- parsing ----------

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const t = content.find((c) => c && c.type === 'text' && typeof c.text === 'string');
    return t ? t.text : '';
  }
  return '';
}

function cleanPrompt(s) {
  if (!s) return '';
  // Slash commands are stored as <command-name>/foo</command-name><command-args>bar</command-args>
  const cmd = s.match(/<command-name>([^<]*)<\/command-name>/);
  if (cmd) {
    const args = (s.match(/<command-args>([\s\S]*?)<\/command-args>/) || [])[1] || '';
    return `${cmd[1]} ${args}`.trim();
  }
  if (s.startsWith('<')) return ''; // system / hook injected content
  return s.replace(/\s+/g, ' ').trim();
}

function parseSession(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const s = {
    id: path.basename(file, '.jsonl'),
    file,
    cwd: '',
    gitBranch: '',
    customTitle: '',
    aiTitle: '',
    summary: '',
    firstPrompt: '',
    lastPrompt: '',
    userMessages: 0,
    created: null,
    updated: null,
    context: null, // { tokens, model, time } of the latest reply
    compactions: [], // [{ pre, post, trigger, time }]
  };
  const col = usage.createCollector();
  for (const line of raw.split('\n')) {
    if (!line) continue;
    // Cheap pre-filter: skip huge lines we don't care about.
    if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"') &&
        !line.includes('title"') && !line.includes('"type":"summary"') && !line.includes('"type":"last-prompt"') &&
        !line.includes('"compact_boundary"')) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    switch (o.type) {
      case 'custom-title': s.customTitle = o.customTitle || s.customTitle; break;
      case 'ai-title': s.aiTitle = o.aiTitle || s.aiTitle; break;
      case 'summary': s.summary = o.summary || s.summary; break;
      case 'last-prompt': s.lastPrompt = cleanPrompt(o.lastPrompt) || s.lastPrompt; break;
      case 'system':
        if (o.subtype === 'compact_boundary' && o.compactMetadata) {
          s.compactions.push({ pre: o.compactMetadata.preTokens || 0, post: o.compactMetadata.postTokens || 0, trigger: o.compactMetadata.trigger || '', time: o.timestamp ? new Date(o.timestamp) : null });
        }
        break;
      case 'user':
      case 'assistant': {
        if (o.type === 'assistant') {
          col.add(o);
          // Size of the conversation Claude saw on its latest reply (main conversation only, not agents).
          const u = o.message && o.message.usage;
          if (u && !o.isSidechain && o.message.model !== '<synthetic>') {
            s.context = {
              tokens: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0),
              model: o.message.model,
              time: o.timestamp ? new Date(o.timestamp) : null,
            };
          }
        }
        if (o.cwd && !s.cwd) s.cwd = o.cwd;
        if (o.gitBranch && o.gitBranch !== 'HEAD') s.gitBranch = o.gitBranch;
        if (o.timestamp) {
          const t = new Date(o.timestamp);
          if (!isNaN(t)) {
            if (!s.created || t < s.created) s.created = t;
            if (!s.updated || t > s.updated) s.updated = t;
          }
        }
        if (o.type === 'user' && !o.isMeta && !o.isSidechain && o.message && o.message.role === 'user') {
          const p = cleanPrompt(textOf(o.message.content));
          if (p) {
            s.userMessages++;
            if (!s.firstPrompt) s.firstPrompt = p;
            s.lastPrompt = p;
          }
        }
        break;
      }
    }
  }
  if (!s.userMessages && !s.customTitle && !s.aiTitle) return null; // empty / aborted session
  // Subagents (Task tool) write their own transcripts next to the session; their tokens count too.
  const subDir = path.join(path.dirname(file), s.id, 'subagents');
  let subs = [];
  try { subs = fs.readdirSync(subDir).filter((f) => f.endsWith('.jsonl')); } catch { /* none */ }
  for (const f of subs) {
    let text = '';
    try { text = fs.readFileSync(path.join(subDir, f), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.includes('"usage"')) continue;
      try { const o = JSON.parse(line); if (o.type === 'assistant') col.add(o); } catch { /* skip */ }
    }
  }
  s.usage = col.days;
  if (!s.cwd) s.cwd = decodeDirName(path.basename(path.dirname(file)));
  s.baseTitle = s.customTitle || s.aiTitle || s.summary || truncate(s.firstPrompt, 70) || s.id;
  s.title = s.baseTitle;
  return s;
}

// ---------- details (parsed lazily when a session is expanded) ----------

const detailCache = new Map(); // file -> { mtimeMs, size, details }
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function fmtTime(t) {
  return t ? t.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
}

function getDetails(s) {
  let st;
  try { st = fs.statSync(s.file); } catch { return null; }
  const c = detailCache.get(s.file);
  if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) return c.details;
  const details = parseDetails(s);
  detailCache.set(s.file, { mtimeMs: st.mtimeMs, size: st.size, details });
  return details;
}

function parseDetails(s) {
  let raw;
  try { raw = fs.readFileSync(s.file, 'utf8'); } catch { return null; }
  const prompts = [];   // { text, time, line }
  const commands = [];  // { cmd, desc, time, line }
  const files = new Map(); // path -> { count, line }
  const edits = [];     // { path, tool, time }
  const cmdById = new Map(); // tool_use id -> command (to mark failures)
  const seen = new Set();
  const md = [];
  let lineNo = 0; // document line of the next entry (entries can span several lines)
  const push = (str) => { const at = lineNo; md.push(str); lineNo += String(str).split('\n').length; return at; };

  push(`# ${s.title}`);
  push('');
  push(`- **Folder:** \`${s.cwd}\``);
  if (s.gitBranch) push(`- **Branch:** \`${s.gitBranch}\``);
  push(`- **${s.isAgent ? 'Agent' : 'Session'} ID:** \`${s.id}\``);
  if (s.isAgent) push(`- **Part of session:** ${s.parent.title} (\`${s.parent.id}\`)`);
  push(`- **Started:** ${s.created.toLocaleString()}  ·  **Updated:** ${s.updated.toLocaleString()}`);
  if (!s.isAgent) push(`- **Resume:** \`${resumeCommandFor(s)}\``);
  push('');

  for (const line of raw.split('\n')) {
    if (!line || (!line.startsWith('{"parentUuid"') && !line.includes('"type":"user"') && !line.includes('"type":"assistant"'))) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if ((o.type !== 'user' && o.type !== 'assistant') || (o.isSidechain && !s.isAgent) || !o.message) continue;
    if (o.uuid) { if (seen.has(o.uuid)) continue; seen.add(o.uuid); }
    const time = o.timestamp ? new Date(o.timestamp) : null;

    if (o.type === 'user') {
      if (Array.isArray(o.message.content)) {
        for (const b of o.message.content) {
          if (b && b.type === 'tool_result' && b.is_error && cmdById.has(b.tool_use_id)) cmdById.get(b.tool_use_id).failed = true;
        }
      }
      if (o.isMeta || o.isCompactSummary) continue;
      const text = cleanPrompt(textOf(o.message.content));
      if (!text) continue;
      const full = typeof o.message.content === 'string' ? o.message.content.trim() : textOf(o.message.content).trim();
      push('');
      push('---');
      const ln = push(`## 👤 Prompt ${prompts.length + 1}  ·  ${fmtTime(time)}`);
      push('');
      push(full.startsWith('<') ? text : full);
      push('');
      prompts.push({ text, time, line: ln });
      continue;
    }

    const blocks = Array.isArray(o.message.content) ? o.message.content : [];
    for (const b of blocks) {
      if (!b) continue;
      if (b.type === 'text' && b.text && b.text.trim()) {
        push('**🤖 Claude:**');
        push('');
        push(b.text.trim());
        push('');
      } else if (b.type === 'tool_use') {
        if (b.id) { if (seen.has(b.id)) continue; seen.add(b.id); }
        const inp = b.input || {};
        if (b.name === 'Bash' && inp.command) {
          const ln = push(`- 💻 \`${truncate(inp.command.replace(/\s+/g, ' '), 200)}\`${inp.description ? ` — ${inp.description}` : ''}`);
          const c = { cmd: inp.command, desc: inp.description || '', time, line: ln, failed: false };
          commands.push(c);
          if (b.id) cmdById.set(b.id, c);
        } else if (EDIT_TOOLS.has(b.name) && (inp.file_path || inp.notebook_path)) {
          const p = inp.file_path || inp.notebook_path;
          const ln = push(`- ✏️ **${b.name}** \`${shortPath(p)}\``);
          const f = files.get(p) || { count: 0, line: ln, tools: new Set() };
          f.count++; f.tools.add(b.name);
          files.set(p, f);
          edits.push({ path: p, tool: b.name, time });
        } else {
          const hint = inp.file_path || inp.pattern || inp.query || inp.url || inp.description || inp.prompt || '';
          push(`- 🔧 **${b.name}**${hint ? ` \`${truncate(String(hint).replace(/\s+/g, ' '), 120)}\`` : ''}`);
        }
      }
    }
  }
  return { prompts, commands, files, edits, markdown: md.join('\n') };
}


function decodeDirName(name) {
  // Lossy fallback: "-Users-me-foo" -> "/Users/me/foo"
  return name.replace(/-/g, '/');
}

function truncate(s, n) {
  return s && s.length > n ? s.slice(0, n - 1) + '…' : s || '';
}

function loadSessions() {
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }); } catch { return out; }
  const seen = new Set();
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(PROJECTS_DIR, d.name);
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      const file = path.join(dir, f);
      seen.add(file);
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      const c = cache.get(file);
      if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) {
        if (c.session) out.push(c.session);
        continue;
      }
      const session = parseSession(file);
      if (session && !session.updated) session.updated = st.mtime;
      if (session && !session.created) session.created = st.birthtime || st.mtime;
      cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, session });
      if (session) out.push(session);
    }
  }
  for (const k of cache.keys()) if (!seen.has(k)) cache.delete(k);
  // Names given with "Rename…" (stored by the extension) take precedence over Claude's titles.
  const names = (namesState && namesState.get('claudeSessions.marks')) || {};
  for (const s of out) s.title = (names[s.id] && names[s.id].name) || s.baseTitle || s.title;
  out.sort((a, b) => b.updated - a.updated);
  return out;
}

// ---------- formatting ----------

function relTime(d) {
  const sec = (Date.now() - d.getTime()) / 1000;
  if (sec < 60) return 'just now';
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  if (sec < 86400 * 7) return `${Math.floor(sec / 86400)}d ago`;
  return d.toLocaleDateString();
}

function dateBucket(d) {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const day = 86400000;
  const t = d.getTime();
  if (t >= start.getTime()) return 'Today';
  if (t >= start.getTime() - day) return 'Yesterday';
  if (t >= start.getTime() - 6 * day) return 'Earlier this week';
  if (t >= start.getTime() - 29 * day) return 'Earlier this month';
  return 'Older';
}

function shortPath(p) {
  const home = os.homedir();
  return p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

function mdEscape(s) {
  return String(s).replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}


module.exports = { PROJECTS_DIR, cache, detailCache, EDIT_TOOLS, textOf, cleanPrompt, parseSession, fmtTime, getDetails, parseDetails, decodeDirName, truncate, loadSessions, relTime, dateBucket, shortPath, mdEscape, setNamesState, setResumeCommand };
