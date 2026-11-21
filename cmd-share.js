// Commands: export for reading, export to continue, import.
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
    const pick = await vscode.window.showInformationMessage(`Saved ${path.basename(uri.fsPath)}.${extra ? ' ' + extra : ''}`, 'Open', REVEAL);
    if (pick === 'Open') vscode.window.showTextDocument(uri);
    if (pick === REVEAL) vscode.commands.executeCommand('revealFileInOS', uri);
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

};
