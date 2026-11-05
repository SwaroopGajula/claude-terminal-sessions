// Claude Terminal Sessions: lists Claude Code terminal sessions from ~/.claude/projects in the sidebar.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
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
  const seen = new Set();
  const md = [];
  const push = (str) => { md.push(str); return md.length - 1; };

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
          commands.push({ cmd: inp.command, desc: inp.description || '', time, line: ln });
        } else if (EDIT_TOOLS.has(b.name) && (inp.file_path || inp.notebook_path)) {
          const p = inp.file_path || inp.notebook_path;
          const ln = push(`- ✏️ **${b.name}** \`${shortPath(p)}\``);
          const f = files.get(p) || { count: 0, line: ln, tools: new Set() };
          f.count++; f.tools.add(b.name);
          files.set(p, f);
        } else {
          const hint = inp.file_path || inp.pattern || inp.query || inp.url || inp.description || inp.prompt || '';
          push(`- 🔧 **${b.name}**${hint ? ` \`${truncate(String(hint).replace(/\s+/g, ' '), 120)}\`` : ''}`);
        }
      }
    }
  }
  return { prompts, commands, files, markdown: md.join('\n') };
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

class SessionsProvider {
  constructor() {
    this._em = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._em.event;
    this.filter = '';
    this.sessions = [];
  }
  refresh() { this.sessions = []; this._em.fire(); }

  getSessions() {
    if (!this.sessions.length) {
      const max = vscode.workspace.getConfiguration('claudeSessions').get('maxSessions', 300);
      this.sessions = loadSessions().slice(0, max);
    }
    if (!this.filter) return this.sessions;
    const q = this.filter.toLowerCase();
    return this.sessions.filter((s) =>
      [s.title, s.firstPrompt, s.lastPrompt, s.cwd, s.id, s.gitBranch].some((v) => v && v.toLowerCase().includes(q)));
  }

  getChildren(el) {
    const groupBy = vscode.workspace.getConfiguration('claudeSessions').get('groupBy', 'date');
    if (!el) {
      const list = this.getSessions();
      if (!list.length) return [{ kind: 'empty' }];
      const groups = new Map();
      for (const s of list) {
        const key = groupBy === 'folder' ? s.cwd : dateBucket(s.updated);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(s);
      }
      return [...groups.entries()].map(([key, items], i) => ({ kind: 'group', key, items, groupBy, first: i === 0 }));
    }
    if (el.kind === 'group') return el.items.map((s) => ({ kind: 'session', s, groupBy }));
    const s = el.s;
    if (el.kind === 'session') {
      const d = getDetails(s);
      const kids = [
        { kind: 'action', s, label: 'Resume session', icon: 'play', cmd: 'claudeSessions.resume', desc: `claude --resume ${s.id.slice(0, 8)}…` },
        { kind: 'action', s, label: 'Open conversation', icon: 'book', cmd: 'claudeSessions.openConversation', desc: 'readable transcript' },
        { kind: 'info', s, label: 'Folder', icon: 'folder', value: shortPath(s.cwd), cmd: 'claudeSessions.openFolder' },
      ];
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
      const it = new vscode.TreeItem(this.filter ? `No sessions match "${this.filter}"` : 'No Claude Code sessions found');
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
    it.id = s.id;
    it.description = el.groupBy === 'folder'
      ? relTime(s.updated)
      : `${path.basename(s.cwd)} · ${relTime(s.updated)}`;
    it.iconPath = new vscode.ThemeIcon('comment-discussion');
    it.contextValue = 'session';

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

function activate(context) {
  const provider = new SessionsProvider();
  const view = vscode.window.createTreeView('claudeSessions.list', { treeDataProvider: provider, showCollapseAll: true });
  context.subscriptions.push(view);

  const setFilter = (f) => {
    provider.filter = f;
    view.message = f ? `Filter: "${f}"` : undefined;
    vscode.commands.executeCommand('setContext', 'claudeSessions.filtered', !!f);
    provider._em.fire();
  };

  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg('claudeSessions.refresh', () => provider.refresh());
  reg('claudeSessions.search', async () => {
    const f = await vscode.window.showInputBox({ prompt: 'Filter by title, prompt, folder, branch or session ID', value: provider.filter });
    if (f !== undefined) setFilter(f.trim());
  });
  reg('claudeSessions.clearFilter', () => setFilter(''));
  reg('claudeSessions.toggleGroup', async () => {
    const cfg = vscode.workspace.getConfiguration('claudeSessions');
    await cfg.update('groupBy', cfg.get('groupBy') === 'folder' ? 'date' : 'folder', vscode.ConfigurationTarget.Global);
    provider._em.fire();
  });

  reg('claudeSessions.resume', (arg) => {
    const s = sessionFrom(arg, provider, view);
    if (!s) return;
    if (!fs.existsSync(s.cwd)) {
      vscode.window.showErrorMessage(`Folder no longer exists: ${s.cwd}`);
      return;
    }
    const bin = vscode.workspace.getConfiguration('claudeSessions').get('claudeCommand', 'claude');
    const term = vscode.window.createTerminal({ name: `Claude: ${truncate(s.title, 30)}`, cwd: s.cwd, iconPath: new vscode.ThemeIcon('comment-discussion') });
    term.show();
    term.sendText(`${bin} --resume ${s.id}`);
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

  // Auto-refresh when session files change (debounced).
  let timer;
  const bump = () => { clearTimeout(timer); timer = setTimeout(() => provider.refresh(), 1500); };
  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(PROJECTS_DIR), '*/*.jsonl'));
  watcher.onDidCreate(bump); watcher.onDidChange(bump); watcher.onDidDelete(bump);
  context.subscriptions.push(watcher, { dispose: () => clearTimeout(timer) });
  // Fallback periodic refresh (watchers outside the workspace can be unreliable) + keeps "x ago" fresh.
  const iv = setInterval(() => { if (view.visible) provider.refresh(); }, 60000);
  context.subscriptions.push({ dispose: () => clearInterval(iv) });
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('claudeSessions')) provider.refresh();
  }));
}

function deactivate() {}

module.exports = { activate, deactivate, _test: { loadSessions, getDetails } };
