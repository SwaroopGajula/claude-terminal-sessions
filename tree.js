// The sidebar tree: groups, session rows, details, agents. Uses vscode.
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
const usage = require('./usage');
const shell = require('./shell');
const agents = require('./agents');
const notify = require('./notify');
const { PROJECTS_DIR, cache, detailCache, EDIT_TOOLS, textOf, cleanPrompt, parseSession, fmtTime, getDetails, parseDetails, decodeDirName, truncate, loadSessions, relTime, dateBucket, shortPath, mdEscape, setNamesState, setResumeCommand } = require('./sessions');
const { SCHEME, docProvider, openConversation, usageConfig, usageSummary, showCost, costLabel, updateCompactRange, contextInfo, contextHigh, contextShort, contextLong, IS_WIN, TRASH, REVEAL, resumeCommand, sessionFrom, sessionsFrom } = require('./ui');

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
  refreshRunning() {
    const prev = this.running;
    this.running = running.readRunning();
    if (prev && this.onRunningChange) this.onRunningChange(prev, this.running);
  }
  followups() { return (this.state && this.state.get(FOLLOWUPS_KEY)) || {}; }
  async setFollowups(map) { await this.state.update(FOLLOWUPS_KEY, map); this._em.fire(); }
  marks() { return (this.state && this.state.get(MARKS_KEY)) || {}; }
  async setMarks(map) { await this.state.update(MARKS_KEY, map); this._em.fire(); }
  get showArchived() { return !!(this.state && this.state.get(SHOW_ARCHIVED_KEY)); }
  get filtering() { return !!(this.filter || this.contentFilter); }
  // Agents of a session with their status (running only while the session itself is open).
  agentsOf(s) {
    const live = this.running.get(s.id) || null;
    return agents.listAgents(s.file, s.id).map((a) => ({ ...a, status: agents.status(a, live) }));
  }
  isArchived(s) {
    const autoDays = vscode.workspace.getConfiguration('claudeSessions').get('autoArchiveDays', 0);
    return marks.isArchived(s, this.marks()[s.id], { autoDays, hasFollowup: !!this.followups()[s.id] });
  }

  allSessions() {
    if (!this.sessions.length) {
      const max = vscode.workspace.getConfiguration('claudeSessions').get('maxSessions', 300);
      this.sessions = loadSessions().slice(0, max);
      updateCompactRange(this.sessions);
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
      const ags = this.agentsOf(s);
      if (ags.length) {
        const runningN = ags.filter((a) => a.status === 'running').length;
        // Running agents first, then newest first.
        const items = [...ags].sort((x, y) => (y.status === 'running') - (x.status === 'running') || (y.started || 0) - (x.started || 0)).map((a) => ({ kind: 'agent', s, a }));
        kids.push({ kind: 'section', s, label: 'Agents', icon: 'hubot', items, expanded: runningN > 0,
          descOverride: runningN ? `${runningN} running · ${ags.length} total` : String(ags.length) });
      }
      kids.push({ kind: 'info', s, label: 'Folder', icon: 'folder', value: shortPath(s.cwd), cmd: 'claudeSessions.openFolder' });
      if (s.gitBranch) kids.push({ kind: 'info', s, label: 'Branch', icon: 'git-branch', value: s.gitBranch });
      kids.push({ kind: 'info', s, label: 'Session ID', icon: 'key', value: s.id, cmd: 'claudeSessions.copyId' });
      if (d) {
        kids.push({ kind: 'section', s, label: 'Prompts', icon: 'comment', items: d.prompts.map((p) => ({ kind: 'prompt', s, p })), expanded: true });
        kids.push({ kind: 'section', s, label: 'Files changed', icon: 'files', items: [...d.files.entries()].map(([fp, f]) => ({ kind: 'file', s, fp, f })) });
        kids.push({ kind: 'section', s, label: 'Commands run', icon: 'terminal', items: d.commands.map((c) => ({ kind: 'cmd', s, c })) });
      }
      const u = s.usage && usageSummary([s]);
      if (u && u.requests) {
        const T = usage.formatTokens;
        const rows = [];
        if (showCost()) rows.push({ kind: 'info', s, label: 'Estimated cost', icon: 'credit-card', value: `${costLabel(u)} at API rates${u.unpriced.length ? ` (no price for ${u.unpriced.join(', ')})` : ''}` });
        rows.push({ kind: 'info', s, label: 'Output tokens', icon: 'arrow-down', value: T(u.output) });
        rows.push({ kind: 'info', s, label: 'Input tokens', icon: 'arrow-up', value: `${T(u.input)} new · ${T(u.cacheWrite5m + u.cacheWrite1h)} cache writes` });
        rows.push({ kind: 'info', s, label: 'Cache reads', icon: 'database', value: T(u.cacheRead) });
        const ctx = contextInfo(s);
        if (ctx) rows.push({ kind: 'info', s, label: 'Context', icon: contextHigh(ctx) ? 'warning' : 'symbol-ruler', value: `${T(ctx.tokens)}${ctx.window ? ` of ${T(ctx.window)} (${ctx.pct}%)` : ''}${s.compactions.length ? ` · compacted ${s.compactions.length}×` : ''}` });
        for (const [model, bm] of Object.entries(u.byModel).sort((a, b) => b[1].cost - a[1].cost)) {
          rows.push({ kind: 'info', s, label: model, icon: 'hubot', value: `${bm.requests} requests · ${T(bm.output)} output${showCost() ? ` · ${usage.formatCost(bm.cost)}` : ''}` });
        }
        kids.push({ kind: 'section', s, label: 'Token usage', icon: 'graph', items: rows, descOverride: showCost() ? costLabel(u) : T(u.output) + ' output' });
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
        const agentCount = el.items.reduce((n, s) => n + this.agentsOf(s).filter((a) => a.status === 'running').length, 0);
        it.description = [waiting && `${waiting} need${waiting === 1 ? 's' : ''} input`, busy && `${busy} working`, `${el.items.length} open`, agentCount && `🤖 ${agentCount} agent${agentCount === 1 ? '' : 's'}`].filter(Boolean).join(' · ');
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
    const ags = this.agentsOf(s);
    const agentsRunning = ags.filter((a) => a.status === 'running').length;
    if (agentsRunning) parts.push(`🤖 ${agentsRunning} agent${agentsRunning === 1 ? '' : 's'} running`);
    const ctx = contextInfo(s);
    if (run && ctx) parts.push(contextShort(ctx));
    if (fu) parts.push(`⏰ ${followups.describeDue(fu.due)}`);
    if (el.groupBy !== 'folder' || el.special) parts.push(path.basename(s.cwd));
    if (!run) parts.push(relTime(s.updated));
    if (m.note) parts.push(`📝 ${truncate(m.note, 40)}`);
    const u = s.usage ? usageSummary([s]) : null;
    if (u && showCost() && u.cost >= 0.01) parts.push(usage.formatCost(u.cost));
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
    if (s.baseTitle && s.title !== s.baseTitle) md.appendMarkdown(`_Renamed. Claude's title: ${mdEscape(s.baseTitle)}_\n\n`);
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
    if (u && u.requests) {
      const models = Object.entries(u.byModel).sort((a, b) => b[1].cost - a[1].cost || b[1].output - a[1].output).map(([k]) => k).join(', ');
      md.appendMarkdown(`\n\n$(graph) ${showCost() ? `**${costLabel(u)}** at API rates · ` : ''}${usage.formatTokens(u.output)} output · ${usage.formatTokens(u.input + u.cacheWrite5m + u.cacheWrite1h)} input · ${usage.formatTokens(u.cacheRead)} cache reads · ${models}`);
    }
    if (run) md.appendMarkdown(`\n\n$(pulse) **${running.STATUS_LABEL[run.status]}**${run.waitingFor ? ` (${mdEscape(run.waitingFor)})` : ''} · process ${run.pid}`);
    if (ctx) md.appendMarkdown(`\n\n$(${contextHigh(ctx) ? 'warning' : 'symbol-ruler'}) ${contextLong(ctx, s)}${run && contextHigh(ctx) ? '. Consider `/compact` or a fresh session.' : ''}`);
    if (ags.length) {
      md.appendMarkdown(`\n\n$(hubot) **${ags.length} agent${ags.length === 1 ? '' : 's'}**${agentsRunning ? `, ${agentsRunning} running` : ''}`);
      for (const a of ags.filter((x) => x.status === 'running').slice(0, 5)) md.appendMarkdown(`\n\n$(sync) ${mdEscape(a.description)}`);
    }
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
      it.description = el.descOverride || String(el.items.length);
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
      const inside = summary.relativeIn(s.cwd, fp);
      const rel = inside !== null ? inside.split(/[\\/]/).slice(0, -1).join('/') : shortPath(path.dirname(fp));
      it.description = `${rel ? rel + ' · ' : ''}${f.count}× ${[...f.tools].join('/')}`;
      it.resourceUri = vscode.Uri.file(fp);
      it.tooltip = `${fp}\n${f.count} change(s)${fs.existsSync(fp) ? '' : '\n(file no longer exists)'}\n\nClick to open the file`;
      it.contextValue = 'sessionFile';
      it.command = fs.existsSync(fp)
        ? { command: 'vscode.open', title: 'Open file', arguments: [vscode.Uri.file(fp)] }
        : { command: 'claudeSessions.openConversation', title: 'Open', arguments: [el, f.line] };
      break;
    }
    case 'agent': {
      const { a } = el;
      const act = agents.agentActivity(a) || {};
      const u = act.usage ? usageSummary([{ usage: act.usage }]) : null;
      const end = a.status === 'running' ? new Date() : act.last;
      it = new vscode.TreeItem(a.description, None);
      const doing = a.status === 'running' && act.lastAction ? act.lastAction : a.type;
      it.description = [agents.STATUS_LABEL[a.status], doing, agents.duration(act.started, end), u && showCost() && u.cost >= 0.01 ? usage.formatCost(u.cost) : ''].filter(Boolean).join(' · ');
      it.iconPath = a.status === 'running' ? new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('charts.blue'))
        : a.status === 'done' ? new vscode.ThemeIcon('pass', new vscode.ThemeColor('charts.green'))
          : new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('disabledForeground'));
      const md = new vscode.MarkdownString(undefined, true);
      md.isTrusted = false;
      md.appendMarkdown(`**${mdEscape(a.description)}**\n\n`);
      md.appendMarkdown(`$(hubot) ${mdEscape(a.type)}${a.model ? ` · ${mdEscape(a.model)}` : ''} · ${a.background ? 'background' : 'foreground'} · **${agents.STATUS_LABEL[a.status]}**`);
      if (a.status === 'stopped') md.appendMarkdown(' (the session ended before the agent finished)');
      if (act.started) md.appendMarkdown(`\n\n$(clock) Started ${fmtTime(act.started)} · ${a.status === 'running' ? 'running for' : 'took'} ${agents.duration(act.started, end)}`);
      if (act.toolCalls) md.appendMarkdown(`\n\n$(tools) ${act.toolCalls} tool call${act.toolCalls === 1 ? '' : 's'}${act.lastAction ? ` · last: ${mdEscape(act.lastAction)}${act.lastActionTime ? ` (${relTime(act.lastActionTime)})` : ''}` : ''}`);
      if (u && u.requests) md.appendMarkdown(`\n\n$(graph) ${showCost() ? `${costLabel(u)} at API rates · ` : ''}${usage.formatTokens(u.output)} output`);
      if (act.prompt) md.appendMarkdown(`\n\n---\n\n**Task:** ${mdEscape(truncate(act.prompt.replace(/\s+/g, ' '), 500))}`);
      if (a.status === 'done' && act.result) md.appendMarkdown(`\n\n**Result:** ${mdEscape(truncate(act.result.replace(/\s+/g, ' '), 400))}`);
      md.appendMarkdown('\n\n_Click to open the agent\'s conversation_');
      it.tooltip = md;
      it.contextValue = 'sessionAgent';
      it.command = { command: 'claudeSessions.openAgent', title: 'Open agent', arguments: [el] };
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


module.exports = { SessionsProvider, childItem, FOLLOWUPS_KEY, MARKS_KEY, SHOW_ARCHIVED_KEY };
