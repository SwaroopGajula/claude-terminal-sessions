// Claude Terminal Sessions: lists Claude Code terminal sessions from ~/.claude/projects in the sidebar.
// This file wires things together; the work happens in the modules required below.
const vscode = require('vscode');
const fs = require('fs');
const running = require('./running');
const followups = require('./followups');
const marks = require('./marks');
const { PROJECTS_DIR, cache, detailCache, EDIT_TOOLS, textOf, cleanPrompt, parseSession, fmtTime, getDetails, parseDetails, decodeDirName, truncate, loadSessions, relTime, dateBucket, shortPath, mdEscape, setNamesState, setResumeCommand } = require('./sessions');
const { SCHEME, docProvider, openConversation, usageConfig, usageSummary, showCost, costLabel, updateCompactRange, contextInfo, contextHigh, contextShort, contextLong, IS_WIN, TRASH, REVEAL, resumeCommand, sessionFrom, sessionsFrom } = require('./ui');
const { SessionsProvider, childItem, FOLLOWUPS_KEY, MARKS_KEY, SHOW_ARCHIVED_KEY } = require('./tree');

function activate(context) {
  setNamesState(context.globalState);
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
    if (!vscode.window.terminals.length) return null;
    const family = new Set([pid, ...(await running.ancestorPids(pid, 3))]);
    for (const t of vscode.window.terminals) {
      const tp = await t.processId;
      if (tp && family.has(tp)) return t;
    }
    return null;
  };


  // ---------- shared helpers used by several command modules ----------
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


  const setFollowup = async (s, fu) => {
    const map = { ...provider.followups() };
    if (fu) map[s.id] = fu; else delete map[s.id];
    await provider.setFollowups(map);
    updateStatus();
  };

  const patchMarks = async (list, patchFor) => {
    let map = provider.marks();
    for (const s of list) map = marks.update(map, s.id, typeof patchFor === 'function' ? patchFor(map[s.id] || {}, s) : patchFor);
    await provider.setMarks(map);
  };
  const many = (list) => (list.length === 1 ? `"${truncate(list[0].title, 50)}"` : `${list.length} sessions`);

  const app = { context, provider, view, reg, setFilter, updateFilterUi, launch, findTerminal, setFollowup, updateStatus, patchMarks, many };
  require('./cmd-sessions')(app);
  require('./cmd-organize')(app);
  require('./cmd-search')(app);
  require('./cmd-reminders')(app);
  require('./cmd-reports')(app);
  require('./cmd-share')(app);
  require('./cmd-diffs')(app);
  require('./alerts')(app);

  // Auto-refresh when session files change (debounced).
  let timer;
  const bump = () => { clearTimeout(timer); timer = setTimeout(() => provider.refresh(), 1500); };
  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(PROJECTS_DIR), '*/*.jsonl'));
  watcher.onDidCreate(bump); watcher.onDidChange(bump); watcher.onDidDelete(bump);
  // Agents write to <session>/subagents/; redraw (no reload) so their status and last action stay current.
  let agentTimer;
  const redraw = () => { clearTimeout(agentTimer); agentTimer = setTimeout(() => { provider._em.fire(); app.checkAgents(); }, 2000); };
  const agentWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(PROJECTS_DIR), '*/*/subagents/*'));
  agentWatcher.onDidCreate(redraw); agentWatcher.onDidChange(redraw); agentWatcher.onDidDelete(redraw);
  context.subscriptions.push(agentWatcher, { dispose: () => clearTimeout(agentTimer) });
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

module.exports = { activate, deactivate, _test: { loadSessions, getDetails, SessionsProvider, setNamesState } };
