// Alerts when a session needs input or an agent finishes.
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

  // ---------- alerts ----------
  const activatedAt = Date.now();
  const knownAgents = new Map(); // "sessionId/agentId" -> finished
  notify.cleanMarkers();
  const alertCfg = (k) => vscode.workspace.getConfiguration('claudeSessions').get(k, true);
  const sessionById = (id) => provider.allSessions().find((x) => x.id === id) || loadSessions().find((x) => x.id === id);
  // Don't alert about a session whose terminal you are looking at right now. VS Code keeps a terminal
  // "active" after you click back into a file, so editor activity in the last 20 seconds means you are not.
  let lastEditorActivity = 0;
  const touch = () => { lastEditorActivity = Date.now(); };
  context.subscriptions.push(vscode.window.onDidChangeTextEditorSelection(touch), vscode.window.onDidChangeActiveTextEditor(touch));
  const watching = async (pid) => {
    if (!vscode.window.state.focused || !vscode.window.activeTerminal) return null;
    if (Date.now() - lastEditorActivity < 20000) return null;
    const t = await findTerminal(pid);
    return t && t === vscode.window.activeTerminal ? t : null;
  };

  const alertWaiting = async (e) => {
    if (!alertCfg('notifyNeedsInput')) return;
    if (await watching(e.pid)) return;
    if (!notify.claimOnce(`wait|${e.sessionId}|${e.updatedAt || ''}|${e.waitingFor || ''}`)) return;
    const s = sessionById(e.sessionId);
    const name = (s && s.title) || e.name || path.basename(e.cwd || '') || 'A Claude session';
    const term = await findTerminal(e.pid);
    const pick = await vscode.window.showInformationMessage(
      `🔔 "${truncate(name, 60)}" needs your input${e.waitingFor ? `: ${truncate(e.waitingFor, 80)}` : ''}`,
      ...(term ? ['Show Terminal'] : []), ...(s ? ['Open Conversation'] : []));
    if (pick === 'Show Terminal') term.show();
    if (pick === 'Open Conversation') openConversation(s, 0);
  };

  const checkAgents = async () => {
    if (!alertCfg('notifyAgentDone')) return;
    for (const [sid, e] of provider.running) {
      const s = sessionById(sid);
      if (!s) continue;
      for (const a of notify.newlyFinished(knownAgents, sid, agents.listAgents(s.file, s.id), activatedAt)) {
        if (!notify.claimOnce(`agent|${sid}|${a.id}`)) continue; // background work: always worth a heads-up
        const term = await findTerminal(e.pid);
        const act = agents.agentActivity(a) || {};
        vscode.window.showInformationMessage(
          `🤖 Agent finished: "${truncate(a.description, 60)}" in "${truncate(s.title, 40)}"${act.started ? ` (${agents.duration(act.started, act.last)})` : ''}`,
          'Open Agent', ...(term ? ['Show Terminal'] : []),
        ).then((pick) => {
          if (pick === 'Open Agent') vscode.commands.executeCommand('claudeSessions.openAgent', { s, a });
          if (pick === 'Show Terminal') term.show();
        });
      }
    }
  };

  provider.onRunningChange = (prev, next) => {
    for (const e of notify.newlyWaiting(prev, next)) alertWaiting(e);
    checkAgents();
  };
  checkAgents(); // learn which agents are already finished, without alerting
  app.checkAgents = checkAgents;
};
