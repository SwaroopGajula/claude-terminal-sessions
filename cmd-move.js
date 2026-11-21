// Commands: move or copy a session to another folder; relink sessions after their folder moved.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const move = require('./move');
const { truncate, shortPath, detailCache, loadSessions } = require('./sessions');
const { sessionFrom } = require('./ui');

module.exports = function register(app) {
  const { provider, view, reg, launch } = app;

  // Choose a folder: open workspace folders and folders of other sessions first, or browse.
  const pickFolder = async (title, exclude) => {
    const seen = new Set([exclude]);
    const items = [];
    const add = (p, detail) => {
      if (!p || seen.has(p) || !fs.existsSync(p)) return;
      seen.add(p);
      items.push({ label: `$(folder) ${path.basename(p)}`, description: shortPath(p), detail, p });
    };
    for (const f of vscode.workspace.workspaceFolders || []) add(f.uri.fsPath, 'Open in this window');
    for (const s of provider.allSessions()) add(s.cwd, 'Used by other sessions');
    items.push({ label: '$(folder-opened) Browse…', description: 'Choose another folder', p: null });
    const pick = await vscode.window.showQuickPick(items, { title, placeHolder: 'Pick the folder', matchOnDescription: true });
    if (!pick) return null;
    if (pick.p) return pick.p;
    const f = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, title, openLabel: 'Use this folder' });
    return f && f[0] ? f[0].fsPath : null;
  };

  const notOpen = (s) => {
    provider.refreshRunning();
    if (!provider.running.has(s.id)) return true;
    vscode.window.showWarningMessage(`"${truncate(s.title, 50)}" is open in a terminal. Exit Claude there first, then try again.`);
    return false;
  };

  const after = async (verb, s, r, cwd) => {
    detailCache.delete(s.file);
    provider.refresh();
    const go = await vscode.window.showInformationMessage(`${verb} "${truncate(s.title, 50)}" to ${path.basename(cwd)}.`, 'Resume Now');
    if (go === 'Resume Now') {
      const moved = loadSessions().find((x) => x.id === r.id);
      if (moved) launch(moved);
    }
  };

  const moveOrCopy = (copy) => async (arg) => {
    const s = sessionFrom(arg, provider, view);
    if (!s || (!copy && !notOpen(s))) return;
    const target = await pickFolder(`${copy ? 'Copy' : 'Move'} "${truncate(s.title, 40)}" to…`, s.cwd);
    if (!target) return;
    const ok = await vscode.window.showWarningMessage(
      `${copy ? 'Copy' : 'Move'} "${truncate(s.title, 50)}" to ${path.basename(target)}?`,
      { modal: true, detail: `From: ${shortPath(s.cwd)}\nTo: ${shortPath(target)}\n\nPaths inside the conversation that start with the old folder are updated, so Claude works in the new folder when you resume.${copy ? '\n\nThe original stays where it is. The copy gets a new session ID.' : ''}` },
      copy ? 'Copy' : 'Move');
    if (!ok) return;
    try {
      const r = move.moveSession(s, target, { copy });
      await after(copy ? 'Copied' : 'Moved', s, r, target);
    } catch (e) {
      vscode.window.showErrorMessage(`Could not ${copy ? 'copy' : 'move'} the session: ${e.message}`);
    }
  };
  reg('claudeSessions.moveSession', moveOrCopy(false));
  reg('claudeSessions.copySession', moveOrCopy(true));

  reg('claudeSessions.relinkFolder', async (arg) => {
    const s = sessionFrom(arg, provider, view);
    if (!s) return;
    const roots = move.missingRoots(s.cwd);
    if (!roots.length) { vscode.window.showInformationMessage(`${shortPath(s.cwd)} still exists, so there is nothing to relink. Use Move to Folder… instead.`); return; }
    const all = provider.allSessions();
    const count = (root) => all.filter((x) => move.isInside(x.cwd, root)).length;
    // Usually the repo itself moved: offer the highest missing folder first.
    let oldRoot = roots[roots.length - 1];
    if (roots.length > 1) {
      const pick = await vscode.window.showQuickPick([...roots].reverse().map((r) => ({
        label: shortPath(r), description: `${count(r)} session${count(r) === 1 ? '' : 's'}`, r,
      })), { title: 'Which folder was moved or renamed?', placeHolder: 'These folders no longer exist' });
      if (!pick) return;
      oldRoot = pick.r;
    }
    const newRoot = await pickFolder(`Where is ${path.basename(oldRoot)} now?`, oldRoot);
    if (!newRoot) return;
    const n = count(oldRoot);
    const ok = await vscode.window.showWarningMessage(
      `Relink ${n} session${n === 1 ? '' : 's'} from ${path.basename(oldRoot)} to ${path.basename(newRoot)}?`,
      { modal: true, detail: `From: ${shortPath(oldRoot)}\nTo: ${shortPath(newRoot)}\n\nEvery session started in that folder (or inside it) is moved to the same place in the new folder, and paths inside the conversations are updated.` },
      'Relink');
    if (!ok) return;
    const { moved, failed } = move.relink(all, oldRoot, newRoot, (x) => provider.running.has(x.id));
    for (const m of moved) detailCache.delete(m.s.file);
    provider.refresh();
    vscode.window.showInformationMessage(`Relinked ${moved.length} session${moved.length === 1 ? '' : 's'} to ${path.basename(newRoot)}.${failed.length ? ` ${failed.length} skipped: ${failed.map((f) => `${truncate(f.s.title, 30)} (${f.error})`).join('; ')}` : ''}`);
  });
};
