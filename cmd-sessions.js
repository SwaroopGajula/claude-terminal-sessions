// Commands: filter, grouping, resume, fork, copy and open.
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
const { SessionsProvider, childItem, FOLLOWUPS_KEY, MARKS_KEY, SHOW_ARCHIVED_KEY } = require('./tree');

module.exports = function register(app) {
  const { context, provider, view, reg, setFilter, updateFilterUi, launch, findTerminal, setFollowup, updateStatus, patchMarks, many } = app;

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
  reg('claudeSessions.openAgent', (arg) => {
    if (!arg || !arg.a) return;
    const { a, s } = arg;
    const act = agents.agentActivity(a) || {};
    const started = act.started || a.started || s.created;
    openConversation({
      id: a.id, file: a.file, title: `Agent: ${a.description}`, cwd: s.cwd, gitBranch: s.gitBranch,
      created: started, updated: act.last || a.lastWrite || started, isAgent: true, parent: s,
    }, 0);
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

};
