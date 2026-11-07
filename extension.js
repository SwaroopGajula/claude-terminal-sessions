// Claude Terminal Sessions: lists Claude Code terminal sessions from ~/.claude/projects in the sidebar.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const share = require('./share');
const running = require('./running');
const followups = require('./followups');
const summary = require('./summary');
const marks = require('./marks');
const search = require('./search');

const { CLAUDE_DIR } = require('./paths');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const cache = new Map(); // file -> { mtimeMs, size, session }

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
  };
  for (const line of raw.split('\n')) {
    if (!line) continue;
    // Cheap pre-filter: skip huge lines we don't care about.
    if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"') &&
        !line.includes('title"') && !line.includes('"type":"summary"') && !line.includes('"type":"last-prompt"')) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    switch (o.type) {
      case 'custom-title': s.customTitle = o.customTitle || s.customTitle; break;
      case 'ai-title': s.aiTitle = o.aiTitle || s.aiTitle; break;
      case 'summary': s.summary = o.summary || s.summary; break;
      case 'last-prompt': s.lastPrompt = cleanPrompt(o.lastPrompt) || s.lastPrompt; break;
      case 'user':
      case 'assistant': {
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
  if (!s.cwd) s.cwd = decodeDirName(path.basename(path.dirname(file)));
  s.title = s.customTitle || s.aiTitle || s.summary || truncate(s.firstPrompt, 70) || s.id;
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
  push(`- **Session ID:** \`${s.id}\``);
  push(`- **Started:** ${s.created.toLocaleString()}  ·  **Updated:** ${s.updated.toLocaleString()}`);
  push(`- **Resume:** \`${resumeCommand(s)}\``);
  push('');

  for (const line of raw.split('\n')) {
    if (!line || (!line.startsWith('{"parentUuid"') && !line.includes('"type":"user"') && !line.includes('"type":"assistant"'))) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if ((o.type !== 'user' && o.type !== 'assistant') || o.isSidechain || !o.message) continue;
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

const SCHEME = 'claude-session';
const docProvider = {
  _em: new vscode.EventEmitter(),
  get onDidChange() { return this._em.event; },
  sessions: new Map(), // id -> session
  provideTextDocumentContent(uri) {
    const s = this.sessions.get(path.basename(uri.path, '.md'));
    const d = s && getDetails(s);
    return d ? d.markdown : 'Session not found.';
  },
};

async function openConversation(s, line) {
  docProvider.sessions.set(s.id, s);
  const name = truncate(s.title.replace(/[\\/:*?"<>|]/g, ' '), 50);
  const uri = vscode.Uri.from({ scheme: SCHEME, path: `/${name}/${s.id}.md` });
  docProvider._em.fire(uri);
  let doc = await vscode.workspace.openTextDocument(uri);
  if (doc.languageId !== 'markdown') doc = await vscode.languages.setTextDocumentLanguage(doc, 'markdown');
  const pos = new vscode.Position(line || 0, 0);
  await vscode.window.showTextDocument(doc, {
    preview: true,
    selection: new vscode.Range(pos, pos),
  });
  if (line) {
    const ed = vscode.window.activeTextEditor;
    if (ed) ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.AtTop);
  }
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

// ---------- tree ----------

const FOLLOWUPS_KEY = 'claudeSessions.followups';
const MARKS_KEY = 'claudeSessions.marks';
const SHOW_ARCHIVED_KEY = 'claudeSessions.showArchived';

class SessionsProvider {
  constructor(state) {
    this._em = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._em.event;
    this.filter = '';
    this.contentFilter = null; // { query, ids: Set } from "Search Inside Conversations"
    this.sessions = [];
    this.state = state; // vscode Memento (globalState) for follow-ups
    this.running = new Map();
    this.refreshRunning();
  }
  refresh() { this.sessions = []; this.refreshRunning(); this._em.fire(); }
  refreshRunning() { this.running = running.readRunning(); }
  followups() { return (this.state && this.state.get(FOLLOWUPS_KEY)) || {}; }
  async setFollowups(map) { await this.state.update(FOLLOWUPS_KEY, map); this._em.fire(); }
  marks() { return (this.state && this.state.get(MARKS_KEY)) || {}; }
  async setMarks(map) { await this.state.update(MARKS_KEY, map); this._em.fire(); }
  get showArchived() { return !!(this.state && this.state.get(SHOW_ARCHIVED_KEY)); }
  get filtering() { return !!(this.filter || this.contentFilter); }
  isArchived(s) {
    const autoDays = vscode.workspace.getConfiguration('claudeSessions').get('autoArchiveDays', 0);
    return marks.isArchived(s, this.marks()[s.id], { autoDays, hasFollowup: !!this.followups()[s.id] });
  }

  allSessions() {
    if (!this.sessions.length) {
      const max = vscode.workspace.getConfiguration('claudeSessions').get('maxSessions', 300);
      this.sessions = loadSessions().slice(0, max);
    }
    return this.sessions;
  }

  getSessions() {
    let list = this.allSessions();
    if (this.contentFilter) list = list.filter((s) => this.contentFilter.ids.has(s.id));
    if (this.filter) {
      const mk = this.marks();
      list = list.filter((s) => marks.matchesFilter(s, mk[s.id], this.filter));
    }
    return list;
  }

  getChildren(el) {
    const groupBy = vscode.workspace.getConfiguration('claudeSessions').get('groupBy', 'date');
    if (!el) {
      const list = this.getSessions();
      if (!list.length) return [{ kind: 'empty' }];
      const roots = [];
      const mk = this.marks();
      const active = list.filter((s) => !this.isArchived(s));
      const archived = list.filter((s) => this.isArchived(s));
      const pinned = active.filter((s) => mk[s.id] && mk[s.id].pinned);
      if (pinned.length) roots.push({ kind: 'group', key: 'Pinned', special: 'pinned', items: pinned, groupBy });
      const byId = new Map(list.map((s) => [s.id, s]));
      const fu = followups.sortedFollowups(this.followups()).filter(([id]) => byId.has(id));
      if (fu.length) roots.push({ kind: 'group', key: 'Follow-ups', special: 'followups', items: fu.map(([id]) => byId.get(id)), groupBy });
      const run = list.filter((s) => this.running.has(s.id))
        .sort((a, b) => running.rank(this.running.get(b.id)) - running.rank(this.running.get(a.id)) || b.updated - a.updated);
      if (run.length) roots.push({ kind: 'group', key: 'Running', special: 'running', items: run, groupBy });
      const groups = new Map();
      for (const s of active) {
        const key = groupBy === 'folder' ? s.cwd : dateBucket(s.updated);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(s);
      }
      const all = roots.concat([...groups.entries()].map(([key, items], i) => ({ kind: 'group', key, items, groupBy, first: i === 0 })));
      if (archived.length && (this.showArchived || this.filtering)) all.push({ kind: 'group', key: 'Archived', special: 'archived', items: archived, groupBy });
      return all.length ? all : [{ kind: 'empty', archivedOnly: archived.length }];
    }
    if (el.kind === 'group') return el.items.map((s) => ({ kind: 'session', s, groupBy, groupKey: el.key, special: el.special }));
    const s = el.s;
    if (el.kind === 'session') {
      const d = getDetails(s);
      const kids = [
        { kind: 'action', s, label: 'Resume session', icon: 'play', cmd: 'claudeSessions.resume', desc: `claude --resume ${s.id.slice(0, 8)}…` },
        { kind: 'action', s, label: 'Fork session', icon: 'repo-forked', cmd: 'claudeSessions.fork', desc: 'new branch of this conversation' },
        { kind: 'action', s, label: 'Open conversation', icon: 'book', cmd: 'claudeSessions.openConversation', desc: 'readable transcript' },
      ];
      const fu = this.followups()[s.id];
      const m = this.marks()[s.id] || {};
      kids.push(fu
        ? { kind: 'action', s, label: `Follow-up ${followups.describeDue(fu.due)}`, icon: 'bell', cmd: 'claudeSessions.setFollowup', desc: fu.note || followups.formatDay(followups.parseDateKey(fu.due)) }
        : { kind: 'action', s, label: 'Set follow-up…', icon: 'bell', cmd: 'claudeSessions.setFollowup', desc: 'remind me later' });
      kids.push(m.note
        ? { kind: 'action', s, label: 'Note', icon: 'note', cmd: 'claudeSessions.editNote', desc: m.note }
        : { kind: 'action', s, label: 'Add note…', icon: 'note', cmd: 'claudeSessions.editNote', desc: 'your own reminder text' });
      kids.push(m.labels
        ? { kind: 'action', s, label: 'Labels', icon: 'tag', cmd: 'claudeSessions.setLabels', desc: m.labels.map((l) => `#${l}`).join(' ') }
        : { kind: 'action', s, label: 'Add labels…', icon: 'tag', cmd: 'claudeSessions.setLabels', desc: 'e.g. #bug #feature' });
      kids.push({ kind: 'info', s, label: 'Folder', icon: 'folder', value: shortPath(s.cwd), cmd: 'claudeSessions.openFolder' });
      if (s.gitBranch) kids.push({ kind: 'info', s, label: 'Branch', icon: 'git-branch', value: s.gitBranch });
      kids.push({ kind: 'info', s, label: 'Session ID', icon: 'key', value: s.id, cmd: 'claudeSessions.copyId' });
      if (d) {
        kids.push({ kind: 'section', s, label: 'Prompts', icon: 'comment', items: d.prompts.map((p) => ({ kind: 'prompt', s, p })), expanded: true });
        kids.push({ kind: 'section', s, label: 'Files changed', icon: 'files', items: [...d.files.entries()].map(([fp, f]) => ({ kind: 'file', s, fp, f })) });
        kids.push({ kind: 'section', s, label: 'Commands run', icon: 'terminal', items: d.commands.map((c) => ({ kind: 'cmd', s, c })) });
      }
      return kids;
    }
    if (el.kind === 'section') return el.items;
    return [];
  }

  getTreeItem(el) {
    if (el.kind === 'empty') {
      if (el.archivedOnly) return new vscode.TreeItem(`All ${el.archivedOnly} sessions are archived (use Show Archived)`);
      return new vscode.TreeItem(this.filter ? `No sessions match "${this.filter}"`
        : this.contentFilter ? `No conversations contain "${this.contentFilter.query}"` : 'No Claude Code sessions found');
    }
    if (el.kind === 'group' && el.special) {
      const collapsed = el.special === 'archived' && !this.filtering;
      const it = new vscode.TreeItem(el.key, collapsed ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded);
      it.id = `group:${el.special}`;
      if (el.special === 'pinned') {
        it.description = `${el.items.length}`;
        it.iconPath = new vscode.ThemeIcon('pinned');
      } else if (el.special === 'archived') {
        it.description = `${el.items.length} · hidden from the list`;
        it.iconPath = new vscode.ThemeIcon('archive');
      } else if (el.special === 'followups') {
        const map = this.followups();
        const due = el.items.filter((s) => followups.isDue(map[s.id])).length;
        it.description = due ? `${due} due · ${el.items.length} total` : `${el.items.length}`;
        it.iconPath = new vscode.ThemeIcon(due ? 'bell-dot' : 'bell', due ? new vscode.ThemeColor('charts.orange') : undefined);
      } else {
        const st = el.items.map((s) => this.running.get(s.id).status);
        const waiting = st.filter((x) => x === 'waiting').length;
        const busy = st.filter((x) => x === 'busy').length;
        it.description = [waiting && `${waiting} need${waiting === 1 ? 's' : ''} input`, busy && `${busy} working`, `${el.items.length} open`].filter(Boolean).join(' · ');
        it.iconPath = new vscode.ThemeIcon('pulse', waiting ? new vscode.ThemeColor('charts.orange') : new vscode.ThemeColor('charts.green'));
      }
      it.contextValue = `group-${el.special}`;
      return it;
    }
    if (el.kind === 'group') {
      const label = el.groupBy === 'folder' ? path.basename(el.key) || el.key : el.key;
      const expand = el.groupBy === 'date' && (el.key === 'Today' || el.key === 'Yesterday' || el.first);
      const it = new vscode.TreeItem(label,
        expand || this.filter ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
      it.description = el.groupBy === 'folder' ? `${shortPath(el.key)} · ${el.items.length}` : `${el.items.length}`;
      it.iconPath = new vscode.ThemeIcon(el.groupBy === 'folder' ? 'folder' : 'calendar');
      it.contextValue = 'group';
      return it;
    }
    if (el.kind !== 'session') return childItem(el);
    const s = el.s;
    const it = new vscode.TreeItem(s.title, vscode.TreeItemCollapsibleState.Collapsed);
    it.id = `${el.groupKey}/${s.id}`; // a session can appear in several groups
    const run = this.running.get(s.id);
    const fu = this.followups()[s.id];
    const m = this.marks()[s.id] || {};
    const archived = this.isArchived(s);
    const parts = [];
    if (m.labels) parts.push(m.labels.map((l) => `#${l}`).join(' '));
    if (run) parts.push(run.status === 'waiting' && run.waitingFor ? `${running.STATUS_LABEL.waiting}: ${run.waitingFor}` : running.STATUS_LABEL[run.status]);
    if (fu) parts.push(`⏰ ${followups.describeDue(fu.due)}`);
    if (el.groupBy !== 'folder' || el.special) parts.push(path.basename(s.cwd));
    if (!run) parts.push(relTime(s.updated));
    if (m.note) parts.push(`📝 ${truncate(m.note, 40)}`);
    it.description = parts.join(' · ');
    if (run) {
      it.iconPath = run.status === 'busy' ? new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('charts.blue'))
        : run.status === 'waiting' ? new vscode.ThemeIcon('bell-dot', new vscode.ThemeColor('charts.orange'))
          : new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.green'));
    } else if (fu) {
      it.iconPath = new vscode.ThemeIcon(followups.isDue(fu) ? 'bell-dot' : 'bell', followups.isDue(fu) ? new vscode.ThemeColor('charts.orange') : undefined);
    } else if (archived) {
      it.iconPath = new vscode.ThemeIcon('archive', new vscode.ThemeColor('disabledForeground'));
    } else if (m.pinned) {
      it.iconPath = new vscode.ThemeIcon('pinned');
    } else {
      it.iconPath = new vscode.ThemeIcon('comment-discussion');
    }
    // "session" plus flags; menus match with regexes such as /^session( |$)/ and / pinned( |$)/
    it.contextValue = ['session', fu && 'fu', m.pinned && 'pinned', archived && 'archived', m.labels && 'labeled', m.note && 'noted'].filter(Boolean).join(' ');

    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = false;
    md.appendMarkdown(`**${mdEscape(s.title)}**\n\n`);
    const desc = s.firstPrompt && s.firstPrompt !== s.title ? s.firstPrompt : '';
    if (desc) md.appendMarkdown(`${mdEscape(truncate(desc, 400))}\n\n`);
    if (s.lastPrompt && s.lastPrompt !== s.firstPrompt) md.appendMarkdown(`_Last prompt:_ ${mdEscape(truncate(s.lastPrompt, 200))}\n\n`);
    md.appendMarkdown('---\n\n');
    md.appendMarkdown(`$(folder) \`${s.cwd}\`\n\n`);
    if (s.gitBranch) md.appendMarkdown(`$(git-branch) \`${s.gitBranch}\`\n\n`);
    md.appendMarkdown(`$(calendar) Started ${s.created.toLocaleString()}\n\n`);
    md.appendMarkdown(`$(history) Updated ${s.updated.toLocaleString()} (${relTime(s.updated)})\n\n`);
    md.appendMarkdown(`$(comment) ${s.userMessages} prompts\n\n`);
    md.appendMarkdown(`$(key) \`${s.id}\``);
    if (run) md.appendMarkdown(`\n\n$(pulse) **${running.STATUS_LABEL[run.status]}**${run.waitingFor ? ` (${mdEscape(run.waitingFor)})` : ''} · process ${run.pid}`);
    if (m.pinned) md.appendMarkdown('\n\n$(pinned) Pinned');
    if (archived) md.appendMarkdown(`\n\n$(archive) Archived${m.archivedAt ? ` on ${new Date(m.archivedAt).toLocaleDateString()}` : ' automatically (idle)'}`);
    if (m.labels) md.appendMarkdown(`\n\n$(tag) ${m.labels.map((l) => `\`#${l}\``).join(' ')}`);
    if (m.note) md.appendMarkdown(`\n\n$(note) ${mdEscape(m.note)}`);
    if (fu) md.appendMarkdown(`\n\n$(bell) **Follow-up ${followups.describeDue(fu.due)}** (${followups.formatDay(followups.parseDateKey(fu.due))})${fu.note ? `: ${mdEscape(fu.note)}` : ''}`);
    it.tooltip = md;
    return it;
  }
}

function childItem(el) {
  const s = el.s;
  const None = vscode.TreeItemCollapsibleState.None;
  let it;
  switch (el.kind) {
    case 'action':
      it = new vscode.TreeItem(el.label, None);
      it.description = el.desc;
      it.iconPath = new vscode.ThemeIcon(el.icon);
      it.command = { command: el.cmd, title: el.label, arguments: [el] };
      break;
    case 'info':
      it = new vscode.TreeItem(el.label, None);
      it.description = el.value;
      it.tooltip = `${el.label}: ${el.value}${el.cmd ? '\n\nClick to ' + (el.cmd.endsWith('copyId') ? 'copy' : 'open in new window') : ''}`;
      it.iconPath = new vscode.ThemeIcon(el.icon);
      if (el.cmd) it.command = { command: el.cmd, title: el.label, arguments: [el] };
      break;
    case 'section':
      it = new vscode.TreeItem(el.label, el.items.length
        ? (el.expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed)
        : None);
      it.description = String(el.items.length);
      it.iconPath = new vscode.ThemeIcon(el.icon);
      break;
    case 'prompt': {
      const { p } = el;
      it = new vscode.TreeItem(truncate(p.text, 80), None);
      it.description = fmtTime(p.time);
      it.tooltip = new vscode.MarkdownString().appendText(truncate(p.text, 1500)).appendMarkdown('\n\n_Click to open the conversation here_');
      it.iconPath = new vscode.ThemeIcon('account');
      it.command = { command: 'claudeSessions.openConversation', title: 'Open', arguments: [el, p.line] };
      break;
    }
    case 'file': {
      const { fp, f } = el;
      it = new vscode.TreeItem(path.basename(fp), None);
      const rel = fp.startsWith(s.cwd + path.sep) ? path.relative(s.cwd, path.dirname(fp)) : shortPath(path.dirname(fp));
      it.description = `${rel ? rel + ' · ' : ''}${f.count}× ${[...f.tools].join('/')}`;
      it.resourceUri = vscode.Uri.file(fp);
      it.tooltip = `${fp}\n${f.count} change(s)${fs.existsSync(fp) ? '' : '\n(file no longer exists)'}\n\nClick to open the file`;
      it.contextValue = 'sessionFile';
      it.command = fs.existsSync(fp)
        ? { command: 'vscode.open', title: 'Open file', arguments: [vscode.Uri.file(fp)] }
        : { command: 'claudeSessions.openConversation', title: 'Open', arguments: [el, f.line] };
      break;
    }
    case 'cmd': {
      const { c } = el;
      const oneLine = c.cmd.replace(/\s+/g, ' ');
      it = new vscode.TreeItem(c.desc || truncate(oneLine, 80), None);
      it.description = c.desc ? truncate(oneLine, 80) : fmtTime(c.time);
      const md = new vscode.MarkdownString();
      if (c.desc) md.appendMarkdown(`**${mdEscape(c.desc)}**\n\n`);
      md.appendCodeblock(truncate(c.cmd, 1500), 'bash');
      md.appendMarkdown(`\n${fmtTime(c.time)} · _Click to see it in the conversation_`);
      it.tooltip = md;
      it.iconPath = new vscode.ThemeIcon('terminal');
      it.contextValue = 'sessionCommand';
      it.command = { command: 'claudeSessions.openConversation', title: 'Open', arguments: [el, c.line] };
      break;
    }
  }
  return it;
}

// ---------- commands ----------

function shq(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

function resumeCommand(s) {
  const bin = vscode.workspace.getConfiguration('claudeSessions').get('claudeCommand', 'claude');
  return `cd ${shq(s.cwd)} && ${bin} --resume ${s.id}`;
}

function sessionFrom(arg, provider, view) {
  if (arg && arg.s) return arg.s;
  const sel = view.selection[0];
  return sel && sel.s;
}

// Sessions a command applies to: every selected session when several are selected (and the
// clicked one is among them), otherwise just the clicked one.
function sessionsFrom(arg, selected, provider, view) {
  const s = sessionFrom(arg, provider, view);
  const many = (Array.isArray(selected) ? selected : []).filter((x) => x && x.kind === 'session').map((x) => x.s);
  if (s && many.length > 1 && many.some((x) => x.id === s.id)) {
    const seen = new Set();
    return many.filter((x) => !seen.has(x.id) && seen.add(x.id));
  }
  return s ? [s] : [];
}

function activate(context) {
  const provider = new SessionsProvider(context.globalState);
  const view = vscode.window.createTreeView('claudeSessions.list', { treeDataProvider: provider, showCollapseAll: true, canSelectMany: true });
  context.subscriptions.push(view);

  const updateFilterUi = () => {
    const msgs = [];
    if (provider.contentFilter) msgs.push(`Conversations containing "${provider.contentFilter.query}" (${provider.contentFilter.ids.size})`);
    if (provider.filter) msgs.push(`Filter: "${provider.filter}"`);
    view.message = msgs.length ? msgs.join(' · ') : undefined;
    vscode.commands.executeCommand('setContext', 'claudeSessions.filtered', provider.filtering);
    provider._em.fire();
  };
  const setFilter = (f) => { provider.filter = f; updateFilterUi(); };
  vscode.commands.executeCommand('setContext', 'claudeSessions.showArchived', provider.showArchived);

  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg('claudeSessions.refresh', () => provider.refresh());
  reg('claudeSessions.search', async () => {
    const f = await vscode.window.showInputBox({ prompt: 'Filter by title, prompt, folder, branch or session ID', value: provider.filter });
    if (f !== undefined) setFilter(f.trim());
  });
  reg('claudeSessions.clearFilter', () => { provider.contentFilter = null; setFilter(''); });
  reg('claudeSessions.toggleGroup', async () => {
    const cfg = vscode.workspace.getConfiguration('claudeSessions');
    await cfg.update('groupBy', cfg.get('groupBy') === 'folder' ? 'date' : 'folder', vscode.ConfigurationTarget.Global);
    provider._em.fire();
  });

  const launch = (s, { fork = false, cwd } = {}) => {
    const dir = cwd || s.cwd;
    if (!fs.existsSync(dir)) {
      vscode.window.showErrorMessage(`Folder no longer exists: ${dir}`);
      return;
    }
    const bin = vscode.workspace.getConfiguration('claudeSessions').get('claudeCommand', 'claude');
    const term = vscode.window.createTerminal({
      name: `${fork ? 'Fork' : 'Claude'}: ${truncate(s.title, 30)}`,
      cwd: dir,
      iconPath: new vscode.ThemeIcon(fork ? 'repo-forked' : 'comment-discussion'),
    });
    term.show();
    term.sendText(`${bin} --resume ${s.id}${fork ? ' --fork-session' : ''}`);
    setTimeout(() => provider.refresh(), 4000);
  };

  // The VS Code terminal running this Claude process, if any (its shell is the parent process).
  const findTerminal = async (pid) => {
    const parent = running.parentPid(pid);
    for (const t of vscode.window.terminals) {
      const tp = await t.processId;
      if (tp && (tp === pid || tp === parent)) return t;
    }
    return null;
  };

  reg('claudeSessions.resume', async (arg) => {
    const s = sessionFrom(arg, provider, view);
    if (!s) return;
    provider.refreshRunning();
    const run = provider.running.get(s.id);
    if (run) {
      const term = await findTerminal(run.pid);
      const choice = await vscode.window.showWarningMessage(
        `"${truncate(s.title, 50)}" is already open (${running.STATUS_LABEL[run.status].toLowerCase()}).`,
        { modal: true, detail: `${term ? 'It is running in a VS Code terminal in this window.' : 'It is running in another terminal or window.'}\n\nResuming the same session twice can mix up the conversation. Fork it instead to continue in a separate copy.` },
        ...(term ? ['Show Terminal'] : []), 'Fork Instead', 'Resume Anyway');
      if (choice === 'Show Terminal') { term.show(); return; }
      if (choice === 'Fork Instead') { launch(s, { fork: true }); return; }
      if (choice !== 'Resume Anyway') return;
    }
    launch(s);
  });

  reg('claudeSessions.fork', (arg) => {
    const s = sessionFrom(arg, provider, view);
    if (s) launch(s, { fork: true });
  });

  // ---------- follow-ups ----------
  const setFollowup = async (s, fu) => {
    const map = { ...provider.followups() };
    if (fu) map[s.id] = fu; else delete map[s.id];
    await provider.setFollowups(map);
    updateStatus();
  };

  reg('claudeSessions.setFollowup', async (arg) => {
    const s = sessionFrom(arg, provider, view);
    if (!s) return;
    const today = new Date();
    const existing = provider.followups()[s.id];
    const opt = (label, d) => ({ label, description: followups.formatDay(d), d });
    const items = [
      opt('Tomorrow', followups.addDays(today, 1)),
      opt('In 2 days', followups.addDays(today, 2)),
      opt('In 3 days', followups.addDays(today, 3)),
      opt('Next Monday', followups.nextWeekday(today, 1)),
      opt('In 1 week', followups.addDays(today, 7)),
      opt('In 2 weeks', followups.addDays(today, 14)),
      { label: 'In N days…', custom: 'days' },
      { label: 'On a date…', custom: 'date' },
    ];
    if (existing) items.push({ label: '$(trash) Clear follow-up', clear: true, description: followups.describeDue(existing.due) });
    const pick = await vscode.window.showQuickPick(items, {
      title: `Follow up on "${truncate(s.title, 50)}"`,
      placeHolder: existing ? `Currently ${followups.describeDue(existing.due)}${existing.note ? `: ${existing.note}` : ''}` : 'When should I remind you?',
    });
    if (!pick) return;
    if (pick.clear) { await setFollowup(s, null); return; }
    let due = pick.d;
    if (pick.custom === 'days') {
      const v = await vscode.window.showInputBox({
        prompt: 'Remind me in how many days?', value: '5', ignoreFocusOut: true,
        validateInput: (x) => (/^\d{1,3}$/.test(x.trim()) && +x > 0 ? null : 'Enter a number of days, e.g. 5'),
      });
      if (!v) return;
      due = followups.addDays(today, parseInt(v, 10));
    } else if (pick.custom === 'date') {
      const v = await vscode.window.showInputBox({
        prompt: 'Remind me on (YYYY-MM-DD)', value: followups.toDateKey(followups.addDays(today, 1)), ignoreFocusOut: true,
        validateInput: (x) => {
          const d = followups.parseDateKey(x);
          if (!d) return 'Use the format YYYY-MM-DD, e.g. 2026-12-01';
          return followups.daysUntil(x.trim(), today) < 0 ? 'That date is in the past' : null;
        },
      });
      if (!v) return;
      due = followups.parseDateKey(v);
    }
    const dueKey = followups.toDateKey(due);
    const note = await vscode.window.showInputBox({
      title: `Follow-up on ${followups.formatDay(due)}`,
      prompt: 'Note for the reminder (optional). Press Enter or Escape to skip.',
      placeHolder: 'e.g. check the deploy, reply to review comments',
      value: existing ? existing.note : '',
      ignoreFocusOut: true,
    });
    // Escape on the optional note keeps the follow-up (without a note) instead of discarding the chosen date.
    const text = note === undefined ? (existing ? existing.note : '') : note.trim();
    await setFollowup(s, {
      due: dueKey,
      note: text,
      title: s.title,
      cwd: s.cwd,
      createdAt: new Date().toISOString(),
      notifiedOn: null,
    });
    const change = await vscode.window.showInformationMessage(
      `🔔 Follow-up set for ${followups.formatDay(due)}${followups.daysUntil(dueKey) < 7 ? ` (${followups.describeDue(dueKey)})` : ''}: ${truncate(s.title, 50)}${text ? `: ${text}` : ''}`,
      'Change');
    if (change === 'Change') vscode.commands.executeCommand('claudeSessions.setFollowup', { s });
  });

  reg('claudeSessions.clearFollowup', async (arg) => {
    const s = sessionFrom(arg, provider, view);
    if (s) await setFollowup(s, null);
  });

  // ---------- pins, notes, labels ----------
  const patchMarks = async (list, patchFor) => {
    let map = provider.marks();
    for (const s of list) map = marks.update(map, s.id, typeof patchFor === 'function' ? patchFor(map[s.id] || {}, s) : patchFor);
    await provider.setMarks(map);
  };
  const many = (list) => (list.length === 1 ? `"${truncate(list[0].title, 50)}"` : `${list.length} sessions`);

  reg('claudeSessions.pin', async (arg, sel) => {
    const list = sessionsFrom(arg, sel, provider, view);
    await patchMarks(list, { pinned: true, archivedAt: null });
  });
  reg('claudeSessions.unpin', async (arg, sel) => {
    await patchMarks(sessionsFrom(arg, sel, provider, view), { pinned: false });
  });

  reg('claudeSessions.editNote', async (arg) => {
    const s = sessionFrom(arg, provider, view);
    if (!s) return;
    const cur = (provider.marks()[s.id] || {}).note || '';
    const v = await vscode.window.showInputBox({
      title: `Note for "${truncate(s.title, 50)}"`,
      prompt: 'Shown under the session and on hover. Leave empty to remove the note.',
      placeHolder: 'e.g. step 2 of 4 done, next: tests',
      value: cur,
      ignoreFocusOut: true,
    });
    if (v === undefined) return;
    await patchMarks([s], { note: v.trim().slice(0, 300) || null });
  });

  reg('claudeSessions.setLabels', async (arg, sel) => {
    const list = sessionsFrom(arg, sel, provider, view);
    if (!list.length) return;
    const map = provider.marks();
    const labelsOf = (s) => (map[s.id] && map[s.id].labels) || [];
    // Labels every chosen session already has start checked; others are left alone unless checked.
    const initial = labelsOf(list[0]).filter((l) => list.every((s) => labelsOf(s).includes(l)));
    const known = [...new Set([...marks.allLabels(map), ...initial])];
    const qp = vscode.window.createQuickPick();
    qp.canSelectMany = true;
    qp.ignoreFocusOut = true;
    qp.title = `Labels for ${many(list)}`;
    qp.placeholder = known.length ? 'Check labels, or type a new one and press Enter' : 'Type a label (e.g. bug, feature, research) and press Enter';
    const base = known.map((l) => ({ label: `#${l}`, l }));
    qp.items = base;
    qp.selectedItems = base.filter((it) => initial.includes(it.l));
    qp.onDidChangeValue((v) => {
      const n = marks.normalizeLabel(v);
      const keep = qp.selectedItems;
      const extra = n && !known.includes(n) ? [{ label: `$(add) #${n}`, description: 'new label', l: n, alwaysShow: true }] : [];
      qp.items = [...extra, ...base];
      qp.selectedItems = qp.items.filter((it) => keep.some((k) => k.l === it.l));
    });
    const chosen = await new Promise((resolve) => {
      qp.onDidAccept(() => {
        const set = new Set(qp.selectedItems.map((it) => it.l));
        // Typing a brand-new label and pressing Enter adds it without having to check it first.
        const n = marks.normalizeLabel(qp.value);
        if (n && (known.includes(n) || !known.some((l) => l.includes(n)))) set.add(n);
        resolve(set);
        qp.hide();
      });
      qp.onDidHide(() => resolve(null));
      qp.show();
    });
    qp.dispose();
    if (!chosen) return;
    const removed = initial.filter((l) => !chosen.has(l));
    await patchMarks(list, (m) => {
      const next = (m.labels || []).filter((l) => !removed.includes(l));
      for (const l of chosen) if (!next.includes(l)) next.push(l);
      return { labels: next };
    });
  });

  reg('claudeSessions.filterByLabel', async () => {
    const map = provider.marks();
    const labels = marks.allLabels(map);
    if (!labels.length) { vscode.window.showInformationMessage('No labels yet. Right-click a session and choose Set Labels… to add one.'); return; }
    const count = (l) => Object.values(map).filter((m) => (m.labels || []).includes(l)).length;
    const pick = await vscode.window.showQuickPick(labels.map((l) => ({ label: `#${l}`, description: `${count(l)} session${count(l) === 1 ? '' : 's'}`, l })), { title: 'Show sessions with label' });
    if (pick) setFilter(`#${pick.l}`);
  });

  // ---------- archive & delete ----------
  reg('claudeSessions.archive', async (arg, sel) => {
    const list = sessionsFrom(arg, sel, provider, view);
    if (!list.length) return;
    await patchMarks(list, { archivedAt: Date.now(), pinned: false, unarchivedAt: null });
    const undo = await vscode.window.showInformationMessage(
      `Archived ${many(list)}. ${provider.showArchived ? '' : 'Use Show Archived in the ⋯ menu to see archived sessions. '}Resuming a session brings it back.`, 'Undo');
    if (undo === 'Undo') await patchMarks(list, { archivedAt: null });
  });
  reg('claudeSessions.unarchive', async (arg, sel) => {
    await patchMarks(sessionsFrom(arg, sel, provider, view), { archivedAt: null, unarchivedAt: Date.now() });
  });
  const setShowArchived = async (v) => {
    await context.globalState.update(SHOW_ARCHIVED_KEY, v);
    vscode.commands.executeCommand('setContext', 'claudeSessions.showArchived', v);
    provider._em.fire();
  };
  reg('claudeSessions.showArchived', () => setShowArchived(true));
  reg('claudeSessions.hideArchived', () => setShowArchived(false));

  reg('claudeSessions.delete', async (arg, sel) => {
    const list = sessionsFrom(arg, sel, provider, view);
    if (!list.length) return;
    provider.refreshRunning();
    const open = list.filter((s) => provider.running.has(s.id));
    if (open.length) {
      vscode.window.showWarningMessage(`${many(open)} ${open.length === 1 ? 'is' : 'are'} still open in a terminal. Exit Claude there first, then delete.`);
      return;
    }
    const names = list.slice(0, 8).map((s) => `• ${truncate(s.title, 70)}`).join('\n') + (list.length > 8 ? `\n…and ${list.length - 8} more` : '');
    const ok = await vscode.window.showWarningMessage(
      `Delete ${many(list)}?`,
      { modal: true, detail: `${names}\n\nThe conversation files are moved to the Trash, so you can restore them from there. After deleting, the session can no longer be resumed.\n\nTo just hide a session, use Archive instead.` },
      'Move to Trash', 'Archive Instead');
    if (ok === 'Archive Instead') { vscode.commands.executeCommand('claudeSessions.archive', { s: list[0] }, list.map((s) => ({ kind: 'session', s }))); return; }
    if (ok !== 'Move to Trash') return;
    const failed = [];
    for (const s of list) {
      const targets = [
        s.file, // the conversation
        path.join(path.dirname(s.file), s.id), // subagent transcripts and large tool results
        path.join(CLAUDE_DIR, 'file-history', s.id), // file backups used by /rewind
        path.join(CLAUDE_DIR, 'session-env', s.id),
      ];
      try {
        for (const t of targets) {
          if (fs.existsSync(t)) await vscode.workspace.fs.delete(vscode.Uri.file(t), { recursive: true, useTrash: true });
        }
      } catch (e) {
        failed.push(`${truncate(s.title, 40)}: ${e.message}`);
        continue;
      }
      cache.delete(s.file);
      detailCache.delete(s.file);
    }
    const gone = new Set(list.filter((s) => !fs.existsSync(s.file)).map((s) => s.id));
    let mk = provider.marks();
    for (const id of gone) mk = marks.remove(mk, id);
    await provider.setMarks(mk);
    const fu = { ...provider.followups() };
    for (const id of gone) delete fu[id];
    await provider.setFollowups(fu);
    if (provider.contentFilter) for (const id of gone) provider.contentFilter.ids.delete(id);
    provider.refresh();
    updateStatus();
    if (failed.length) vscode.window.showErrorMessage(`Could not delete: ${failed.join('; ')}`);
    else vscode.window.setStatusBarMessage(`Moved ${gone.size} session${gone.size === 1 ? '' : 's'} to the Trash`, 4000);
  });

  // ---------- search inside conversations ----------
  const KIND = {
    prompt: ['account', 'Your prompt'],
    reply: ['sparkle', 'Claude'],
    command: ['terminal', 'Command'],
    file: ['edit', 'File changed'],
    tool: ['tools', 'Tool'],
  };
  let lastQuery = '';
  reg('claudeSessions.searchConversations', async () => {
    const q = await vscode.window.showInputBox({
      title: 'Search inside conversations',
      prompt: 'Searches your prompts, Claude\'s replies, commands and changed files in every session. All words must appear on the same line.',
      placeHolder: 'e.g. ThemeToggle.tsx, npm test, migration',
      value: lastQuery,
    });
    if (!q || !q.trim()) return;
    lastQuery = q.trim();
    const results = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Searching conversations for "${lastQuery}"`, cancellable: true },
      async (progress, token) => {
        const list = provider.allSessions();
        const out = [];
        for (let i = 0; i < list.length; i++) {
          if (token.isCancellationRequested) break;
          if (i % 5 === 0) {
            progress.report({ message: `${i} of ${list.length}`, increment: (5 / list.length) * 100 });
            await new Promise((r) => setImmediate(r));
          }
          const d = getDetails(list[i]);
          if (!d) continue;
          const r = search.searchConversation(d.markdown, lastQuery, { limit: 20 });
          if (r.total) out.push({ s: list[i], ...r });
        }
        return out;
      });
    if (!results.length) { vscode.window.showInformationMessage(`No conversation contains "${lastQuery}".`); return; }
    const total = results.reduce((n, r) => n + r.total, 0);
    const items = [{
      label: `$(filter) Show the ${results.length} matching session${results.length === 1 ? '' : 's'} in the sidebar`,
      description: `${total} match${total === 1 ? '' : 'es'}`,
      filter: true,
      alwaysShow: true,
    }];
    for (const r of results) {
      items.push({ label: `${r.s.title} · ${path.basename(r.s.cwd)}`, kind: vscode.QuickPickItemKind.Separator });
      for (const m of r.matches) {
        const [icon, name] = KIND[m.kind] || KIND.tool;
        items.push({ label: `$(${icon}) ${m.snippet}`, description: name, s: r.s, line: m.line });
      }
      if (r.total > r.matches.length) items.push({ label: `$(ellipsis) ${r.total - r.matches.length} more in this session`, description: 'open the conversation', s: r.s, line: r.matches[r.matches.length - 1].line });
    }
    const pick = await vscode.window.showQuickPick(items, {
      title: `"${lastQuery}": ${total} match${total === 1 ? '' : 'es'} in ${results.length} session${results.length === 1 ? '' : 's'}`,
      placeHolder: 'Pick a match to open the conversation at that point',
      matchOnDescription: true,
    });
    if (!pick) return;
    if (pick.filter) {
      provider.contentFilter = { query: lastQuery, ids: new Set(results.map((r) => r.s.id)) };
      updateFilterUi();
      return;
    }
    openConversation(pick.s, pick.line);
  });

  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusItem.command = 'claudeSessions.showDue';
  context.subscriptions.push(statusItem);
  const updateStatus = () => {
    const map = provider.followups();
    const due = Object.values(map).filter((f) => followups.isDue(f)).length;
    const waiting = [...provider.running.values()].filter((r) => r.status === 'waiting').length;
    const parts = [];
    if (due) parts.push(`$(bell-dot) ${due} follow-up${due === 1 ? '' : 's'} due`);
    if (waiting) parts.push(`$(comment-unresolved) ${waiting} need${waiting === 1 ? 's' : ''} input`);
    if (!parts.length) { statusItem.hide(); return; }
    statusItem.text = parts.join('  ');
    statusItem.tooltip = 'Claude Terminal Sessions: click to see what needs attention';
    statusItem.show();
  };

  reg('claudeSessions.showDue', async () => {
    const map = provider.followups();
    const byId = new Map((provider.sessions.length ? provider.sessions : loadSessions()).map((s) => [s.id, s]));
    const items = [];
    for (const [id, r] of provider.running) {
      if (r.status === 'waiting' && byId.has(id)) items.push({ label: `$(comment-unresolved) ${byId.get(id).title}`, description: `Needs input${r.waitingFor ? `: ${r.waitingFor}` : ''}`, s: byId.get(id) });
    }
    for (const [id, f] of followups.sortedFollowups(map)) {
      const s = byId.get(id) || { id, title: f.title, cwd: f.cwd, created: new Date(), updated: new Date() };
      items.push({ label: `$(bell) ${s.title}`, description: followups.describeDue(f.due), detail: f.note || undefined, s, fu: true });
    }
    if (!items.length) { vscode.window.showInformationMessage('Nothing needs your attention.'); return; }
    const pick = await vscode.window.showQuickPick(items, { title: 'Needs attention', placeHolder: 'Pick a session to resume' });
    if (pick) vscode.commands.executeCommand('claudeSessions.resume', { s: pick.s });
  });

  // Pop up reminders for due follow-ups (once per day per follow-up, across windows).
  let notifying = false;
  const notifyDue = async () => {
    if (notifying) return;
    notifying = true;
    try {
      const todayKey = followups.toDateKey(new Date());
      for (const [id, f] of followups.toNotify(provider.followups())) {
        const fresh = { ...provider.followups() };
        if (!fresh[id] || fresh[id].notifiedOn === todayKey) continue;
        fresh[id] = { ...fresh[id], notifiedOn: todayKey };
        await provider.setFollowups(fresh);
        const s = loadSessions().find((x) => x.id === id) || { id, title: f.title, cwd: f.cwd };
        vscode.window.showInformationMessage(
          `⏰ Follow-up ${followups.describeDue(f.due)}: ${truncate(f.title || s.title, 60)}${f.note ? `: ${f.note}` : ''}`,
          'Resume', 'Snooze 1 Day', 'Done',
        ).then(async (choice) => {
          if (choice === 'Resume') vscode.commands.executeCommand('claudeSessions.resume', { s });
          if (choice === 'Snooze 1 Day') {
            const m = { ...provider.followups() };
            if (m[id]) m[id] = { ...m[id], due: followups.toDateKey(followups.addDays(new Date(), 1)), notifiedOn: null };
            await provider.setFollowups(m);
            updateStatus();
          }
          if (choice === 'Done') await setFollowup({ id }, null);
        });
      }
    } finally {
      notifying = false;
      updateStatus();
    }
  };
  setTimeout(notifyDue, 5000);
  const fuTimer = setInterval(notifyDue, 30 * 60 * 1000);
  context.subscriptions.push({ dispose: () => clearInterval(fuTimer) });

  // ---------- daily summary ----------
  reg('claudeSessions.dailySummary', async () => {
    const R = summary.ranges();
    const items = [
      { label: 'Today', r: R.today },
      { label: 'Yesterday', r: R.yesterday },
      ...(R.lastWorkday.from.getTime() !== R.yesterday.from.getTime() ? [{ label: 'Last working day', r: R.lastWorkday }] : []),
      { label: 'This week', r: R.thisWeek },
      { label: 'Last 7 days', r: R.last7 },
      { label: 'Pick a date…', pickDate: true },
    ].map((x) => ({ ...x, description: x.r ? x.r.from.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) : '' }));
    const pick = await vscode.window.showQuickPick(items, { title: 'Summary of Claude Code work', placeHolder: 'Which period?' });
    if (!pick) return;
    let range = pick.r && { ...pick.r };
    if (pick.pickDate) {
      const v = await vscode.window.showInputBox({
        prompt: 'Date (YYYY-MM-DD)', value: followups.toDateKey(R.yesterday.from),
        validateInput: (x) => (followups.parseDateKey(x) ? null : 'Use the format YYYY-MM-DD'),
      });
      if (!v) return;
      range = { ...summary.dayRange(followups.parseDateKey(v)), label: '' };
    }
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'Building Claude Code summary…' },
      async () => {
        const list = loadSessions().filter((s) => s.updated >= range.from && s.created < range.to);
        return summary.buildSummary(list.map((s) => ({ s, d: getDetails(s) })), range);
      });
    const doc = await vscode.workspace.openTextDocument({ content: result.markdown, language: 'markdown' });
    await vscode.window.showTextDocument(doc, { preview: false });
    const next = await vscode.window.showInformationMessage(
      result.count ? `Summary of ${result.count} session${result.count === 1 ? '' : 's'} ready.` : 'No Claude Code activity in that period.',
      ...(result.count ? ['Copy to Clipboard', 'Open Preview'] : []));
    if (next === 'Copy to Clipboard') { await vscode.env.clipboard.writeText(result.markdown); vscode.window.setStatusBarMessage('Summary copied', 3000); }
    if (next === 'Open Preview') vscode.commands.executeCommand('markdown.showPreview', doc.uri);
  });
  reg('claudeSessions.copyId', async (arg) => {
    const s = sessionFrom(arg, provider, view);
    if (!s) return;
    await vscode.env.clipboard.writeText(s.id);
    vscode.window.setStatusBarMessage(`Copied session ID ${s.id}`, 3000);
  });
  reg('claudeSessions.copyCommand', async (arg) => {
    const s = sessionFrom(arg, provider, view);
    if (!s) return;
    await vscode.env.clipboard.writeText(resumeCommand(s));
    vscode.window.setStatusBarMessage('Copied resume command', 3000);
  });
  reg('claudeSessions.openFolder', (arg) => {
    const s = sessionFrom(arg, provider, view);
    if (s) vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(s.cwd), { forceNewWindow: true });
  });
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(SCHEME, docProvider));
  reg('claudeSessions.openConversation', (arg, line) => {
    const s = sessionFrom(arg, provider, view);
    if (s) openConversation(s, typeof line === 'number' ? line : 0);
  });
  reg('claudeSessions.copyShellCommand', async (arg) => {
    if (!arg || !arg.c) return;
    await vscode.env.clipboard.writeText(arg.c.cmd);
    vscode.window.setStatusBarMessage('Copied command', 3000);
  });
  reg('claudeSessions.runShellCommand', (arg) => {
    if (!arg || !arg.c) return;
    const term = vscode.window.createTerminal({ name: 'Claude cmd', cwd: fs.existsSync(arg.s.cwd) ? arg.s.cwd : undefined });
    term.show();
    term.sendText(arg.c.cmd, false); // typed but NOT executed — user presses Enter
  });
  reg('claudeSessions.openTranscript', (arg) => {
    const s = sessionFrom(arg, provider, view);
    if (s) vscode.window.showTextDocument(vscode.Uri.file(s.file), { preview: true });
  });

  // ---------- sharing ----------
  const extVersion = context.extension.packageJSON.version;
  const slug = (t) => (t || 'session').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'session';
  const downloads = () => {
    const d = path.join(os.homedir(), 'Downloads');
    return fs.existsSync(d) ? d : os.homedir();
  };
  const redactionNote = (r) => (r.total
    ? `${r.total} likely secret(s) were removed automatically (${share.summarizeCounts(r.counts)}).`
    : 'No secrets were detected automatically.');
  const afterSave = async (uri, extra) => {
    const pick = await vscode.window.showInformationMessage(`Saved ${path.basename(uri.fsPath)}.${extra ? ' ' + extra : ''}`, 'Open', 'Reveal in Finder');
    if (pick === 'Open') vscode.window.showTextDocument(uri);
    if (pick === 'Reveal in Finder') vscode.commands.executeCommand('revealFileInOS', uri);
  };

  reg('claudeSessions.exportMarkdown', async (arg) => {
    const s = sessionFrom(arg, provider, view);
    const d = s && getDetails(s);
    if (!d) return;
    const r = share.redact(d.markdown);
    const ok = await vscode.window.showWarningMessage(
      `Export "${truncate(s.title, 60)}" for reading?`,
      { modal: true, detail: `The file contains your prompts, Claude's replies and the commands it ran (not their output).\n\n${redactionNote(r)}\n\nAutomatic detection is not perfect: read the file before you share it.` },
      'Save…');
    if (ok !== 'Save…') return;
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(downloads(), `${slug(s.title)}.md`)),
      filters: { Markdown: ['md'] },
      title: 'Export session for reading',
    });
    if (!uri) return;
    const header = `> Exported from Claude Terminal Sessions on ${new Date().toLocaleString()}. ${r.total ? `${r.total} likely secret(s) replaced with [REDACTED].` : ''}\n\n`;
    fs.writeFileSync(uri.fsPath, header + r.text);
    afterSave(uri);
  });

  reg('claudeSessions.exportSession', async (arg) => {
    const s = sessionFrom(arg, provider, view);
    if (!s) return;
    let built;
    try { built = share.buildBundle(s, extVersion); } catch (e) { vscode.window.showErrorMessage(`Export failed: ${e.message}`); return; }
    const r = built.redaction;
    const ok = await vscode.window.showWarningMessage(
      `Export "${truncate(s.title, 60)}" so someone else can continue it?`,
      { modal: true, detail: `The file contains the FULL conversation, including command output and the contents of files Claude read.\n\n${redactionNote(r)} Claude Code's internal request logs are left out.\n\nAutomatic detection is not perfect. Only share with people who are allowed to see this code and data.` },
      'Save…');
    if (ok !== 'Save…') return;
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(downloads(), `${slug(s.title)}.claude-session.json`)),
      filters: { 'Claude session': ['json'] },
      title: 'Export session to continue elsewhere',
    });
    if (!uri) return;
    fs.writeFileSync(uri.fsPath, built.json, { mode: 0o600 });
    afterSave(uri, 'The other person imports it with the Import Session button in Claude Terminal Sessions.');
  });

  reg('claudeSessions.importSession', async () => {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { 'Claude session': ['json'] },
      defaultUri: vscode.Uri.file(downloads()),
      title: 'Import a shared Claude session',
      openLabel: 'Import',
    });
    if (!picked || !picked[0]) return;
    let b;
    try { b = share.readBundle(picked[0].fsPath); } catch (e) { vscode.window.showErrorMessage(e.message); return; }
    const meta = b.session;

    // Choose the local copy of the project this session belongs to.
    const want = meta.folderName || path.basename(meta.cwd);
    const seen = new Set();
    const items = [];
    const add = (p, detail) => {
      if (!p || seen.has(p) || !fs.existsSync(p)) return;
      seen.add(p);
      const match = path.basename(p) === want;
      items.push({ label: `$(folder) ${path.basename(p)}`, description: shortPath(p), detail: match ? `Matches the original folder name "${want}"${detail ? ' · ' + detail : ''}` : detail, p, match });
    };
    if (fs.existsSync(meta.cwd)) add(meta.cwd, 'Same path as on the original computer');
    for (const f of vscode.workspace.workspaceFolders || []) add(f.uri.fsPath, 'Open in this window');
    for (const s of provider.sessions.length ? provider.sessions : loadSessions()) if (path.basename(s.cwd) === want) add(s.cwd, 'Used in your other sessions');
    items.sort((a, c) => Number(c.match) - Number(a.match));
    items.push({ label: '$(folder-opened) Browse…', description: 'Choose another folder', p: null });
    const choice = await vscode.window.showQuickPick(items, {
      title: `Import "${truncate(meta.title, 50)}": choose your local copy of "${want}"`,
      placeHolder: `Originally in ${meta.cwd}${meta.gitBranch ? ` on branch ${meta.gitBranch}` : ''}`,
      matchOnDescription: true,
    });
    if (!choice) return;
    let target = choice.p;
    if (!target) {
      const f = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, title: `Choose your local copy of "${want}"`, openLabel: 'Use this folder' });
      if (!f || !f[0]) return;
      target = f[0].fsPath;
    }

    // Avoid clashing with a session that already has this ID.
    let newId;
    const existing = share.findExisting(meta.id);
    if (existing.length) {
      const same = existing.includes(path.join(share.projectDirFor(target), `${meta.id}.jsonl`));
      const opt = await vscode.window.showQuickPick([
        { label: 'Import as a copy', description: 'Recommended: gets a new session ID', v: 'copy' },
        ...(same ? [{ label: 'Replace the existing session', description: 'Overwrites your local copy of this session', v: 'replace' }] : []),
      ], { title: 'This session already exists on this computer' });
      if (!opt) return;
      if (opt.v === 'copy') newId = share.newSessionId();
    }

    let res;
    try { res = share.importBundle(b, target, { newId }); } catch (e) { vscode.window.showErrorMessage(`Import failed: ${e.message}`); return; }
    provider.refresh();
    const go = await vscode.window.showInformationMessage(
      `Imported "${truncate(meta.title, 50)}" into ${path.basename(target)}.${meta.gitBranch ? ` It was on branch ${meta.gitBranch}; check out the same code for best results.` : ''}`,
      'Resume now', 'Copy session ID');
    if (go === 'Resume now') {
      const bin = vscode.workspace.getConfiguration('claudeSessions').get('claudeCommand', 'claude');
      const term = vscode.window.createTerminal({ name: `Claude: ${truncate(meta.title, 30)}`, cwd: target, iconPath: new vscode.ThemeIcon('comment-discussion') });
      term.show();
      term.sendText(`${bin} --resume ${res.id}`);
    } else if (go === 'Copy session ID') {
      await vscode.env.clipboard.writeText(res.id);
    }
  });

  // Auto-refresh when session files change (debounced).
  let timer;
  const bump = () => { clearTimeout(timer); timer = setTimeout(() => provider.refresh(), 1500); };
  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(PROJECTS_DIR), '*/*.jsonl'));
  watcher.onDidCreate(bump); watcher.onDidChange(bump); watcher.onDidDelete(bump);
  context.subscriptions.push(watcher, { dispose: () => clearTimeout(timer) });
  // Live status: Claude Code rewrites ~/.claude/sessions/<pid>.json when a session starts, stops or changes status.
  let runTimer;
  const bumpRunning = () => {
    clearTimeout(runTimer);
    runTimer = setTimeout(() => { provider.refreshRunning(); provider._em.fire(); updateStatus(); }, 700);
  };
  try {
    const w = fs.watch(running.SESSIONS_DIR, bumpRunning);
    context.subscriptions.push({ dispose: () => { w.close(); clearTimeout(runTimer); } });
  } catch { /* folder may not exist yet; the periodic refresh covers it */ }
  updateStatus();

  // Fallback periodic refresh (watchers outside the workspace can be unreliable) + keeps "x ago" fresh.
  const iv = setInterval(() => { if (view.visible) provider.refresh(); else { provider.refreshRunning(); updateStatus(); } }, 60000);
  context.subscriptions.push({ dispose: () => clearInterval(iv) });
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('claudeSessions')) provider.refresh();
  }));
}

function deactivate() {}

module.exports = { activate, deactivate, _test: { loadSessions, getDetails, SessionsProvider } };
