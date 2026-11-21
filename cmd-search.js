// Command: search inside conversations.
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
};
