// Commands: daily summary and token usage report.
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
        const keys = { fromKey: usage.dayKey(range.from), toKey: usage.dayKey(new Date(range.to - 1)) };
        return summary.buildSummary(list.map((s) => ({ s, d: getDetails(s), u: showCost() && s.usage ? usageSummary([s], keys) : null })), range);
      });
    const doc = await vscode.workspace.openTextDocument({ content: result.markdown, language: 'markdown' });
    await vscode.window.showTextDocument(doc, { preview: false });
    const next = await vscode.window.showInformationMessage(
      result.count ? `Summary of ${result.count} session${result.count === 1 ? '' : 's'} ready.` : 'No Claude Code activity in that period.',
      ...(result.count ? ['Copy to Clipboard', 'Open Preview'] : []));
    if (next === 'Copy to Clipboard') { await vscode.env.clipboard.writeText(result.markdown); vscode.window.setStatusBarMessage('Summary copied', 3000); }
    if (next === 'Open Preview') vscode.commands.executeCommand('markdown.showPreview', doc.uri);
  });
  // ---------- usage report ----------
  reg('claudeSessions.usageReport', async () => {
    const R = summary.ranges();
    const last30 = new Date(R.today.from); last30.setDate(last30.getDate() - 29);
    const k = (r) => ({ fromKey: usage.dayKey(r.from), toKey: usage.dayKey(new Date(r.to - 1)) });
    const items = [
      { label: 'Today', ...k(R.today) },
      { label: 'Yesterday', ...k(R.yesterday) },
      { label: 'This week', ...k(R.thisWeek) },
      { label: 'Last 7 days', ...k(R.last7) },
      { label: 'Last 30 days', ...k({ from: last30, to: R.today.to }) },
      { label: 'All time' },
    ].map((x) => ({ ...x, description: x.fromKey ? (x.fromKey === x.toKey ? x.fromKey : `${x.fromKey} to ${x.toKey}`) : 'every session on this computer' }));
    const pick = await vscode.window.showQuickPick(items, { title: 'Claude Code token usage and estimated cost', placeHolder: 'Which period?' });
    if (!pick) return;
    const md = usage.buildReport(loadSessions().map((s) => ({ title: s.title, cwd: s.cwd, usage: s.usage })), {
      label: pick.label, fromKey: pick.fromKey, toKey: pick.toKey, overrides: usageConfig().get('modelPricing', {}) || {},
    });
    const doc = await vscode.workspace.openTextDocument({ content: md, language: 'markdown' });
    await vscode.window.showTextDocument(doc, { preview: false });
    vscode.commands.executeCommand('markdown.showPreview', doc.uri);
  });

};
