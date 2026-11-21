// Follow-up reminders and the "what needs attention" list.
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

};
