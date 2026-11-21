// Commands: what a session changed, in VS Code's diff view.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const diffs = require('./diffs');
const { truncate } = require('./sessions');
const { sessionFrom } = require('./ui');

const SCHEME = 'claude-diff';

module.exports = function register(app) {
  const { context, provider, view, reg } = app;

  // Read-only documents holding "before" and "after" contents.
  const store = new Map(); // key -> text
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
    provideTextDocumentContent: (uri) => store.get(new URLSearchParams(uri.query).get('k')) ?? '',
  }));
  let n = 0;
  // The file name stays last in the path so VS Code picks the right language colors.
  const doc = (c, side, text) => {
    const k = `${++n}`;
    store.set(k, text);
    if (store.size > 400) store.delete(store.keys().next().value);
    return vscode.Uri.from({ scheme: SCHEME, path: `/${side}/${path.basename(c.file)}`, query: `k=${k}` });
  };
  const sideNames = (c) => ({
    before: c.created ? 'new file' : c.mode === 'parts' ? 'changed parts, before' : 'before the session',
    after: c.mode === 'parts' ? 'changed parts, after' : c.mode === 'approximate' ? "after Claude's changes, approximate" : "after Claude's changes",
  });

  const changeFrom = (arg) => {
    if (arg && arg.change) return { s: arg.s, c: arg.change };
    if (arg && arg.s && arg.fp) {
      const c = diffs.sessionChanges(arg.s).find((x) => x.file === arg.fp);
      return c ? { s: arg.s, c } : null;
    }
    return null;
  };

  reg('claudeSessions.showChanges', async (arg) => {
    const x = changeFrom(arg);
    if (!x) { vscode.window.showInformationMessage('No recorded changes for this file.'); return; }
    const { c } = x;
    const names = sideNames(c);
    await vscode.commands.executeCommand('vscode.diff', doc(c, 'before', c.before), doc(c, 'after', c.after),
      `${path.basename(c.file)} (${names.before} ↔ ${names.after})`, { preview: true });
  });

  reg('claudeSessions.compareWithCurrent', async (arg) => {
    const x = changeFrom(arg);
    if (!x) return;
    const { c } = x;
    if (!fs.existsSync(c.file)) { vscode.window.showInformationMessage(`${path.basename(c.file)} no longer exists.`); return; }
    if (c.mode === 'parts') { vscode.window.showInformationMessage('There is no backup of the whole file from before the session, so it cannot be compared with the current file.'); return; }
    await vscode.commands.executeCommand('vscode.diff', doc(c, 'before', c.before), vscode.Uri.file(c.file),
      `${path.basename(c.file)} (${sideNames(c).before} ↔ now)`, { preview: true });
  });

  reg('claudeSessions.openChangedFile', (arg) => {
    if (arg && arg.fp && fs.existsSync(arg.fp)) vscode.commands.executeCommand('vscode.open', vscode.Uri.file(arg.fp));
  });

  // All changed files of a session, one after another (VS Code's multi-file diff view when available).
  reg('claudeSessions.reviewChanges', async (arg) => {
    const s = sessionFrom(arg, provider, view);
    if (!s) return;
    const list = diffs.sessionChanges(s);
    if (!list.length) { vscode.window.showInformationMessage(`"${truncate(s.title, 50)}" didn't change any files with Claude's edit tools.`); return; }
    const add = list.reduce((t, c) => t + c.added, 0);
    const del = list.reduce((t, c) => t + c.removed, 0);
    const title = `Changes in "${truncate(s.title, 40)}": ${list.length} file${list.length === 1 ? '' : 's'}, +${add} −${del}`;
    const resources = list.map((c) => [vscode.Uri.file(c.file), doc(c, 'before', c.before), doc(c, 'after', c.after)]);
    try {
      await vscode.commands.executeCommand('vscode.changes', title, resources);
    } catch {
      // Older VS Code: pick a file to diff.
      const pick = await vscode.window.showQuickPick(list.map((c) => ({
        label: path.basename(c.file), description: `+${c.added} −${c.removed}${c.created ? ' · new' : ''}`, detail: c.file, c,
      })), { title, placeHolder: 'Pick a file to see what Claude changed' });
      if (pick) vscode.commands.executeCommand('claudeSessions.showChanges', { s, change: pick.c });
    }
  });
};
