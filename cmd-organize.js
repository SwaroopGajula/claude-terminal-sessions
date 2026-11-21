// Commands: follow-ups, pins, names, notes, labels, archive and delete.
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

  reg('claudeSessions.setFollowup', async (arg) => {
    const s = sessionFrom(arg, provider, view);
    if (!s) return;
    const today = new Date();
    const existing = provider.followups()[s.id];
    const opt = (label, d) => ({ label, description: followups.formatDay(d), d });
    const items = [
      opt('Tomorrow', followups.addDays(today, 1)),
      opt('In 2 days', followups.addDays(today, 2)),
      opt('In 3 days', followups.addDays(today, 3)),
      opt('Next Monday', followups.nextWeekday(today, 1)),
      opt('In 1 week', followups.addDays(today, 7)),
      opt('In 2 weeks', followups.addDays(today, 14)),
      { label: 'In N days…', custom: 'days' },
      { label: 'On a date…', custom: 'date' },
    ];
    if (existing) items.push({ label: '$(trash) Clear follow-up', clear: true, description: followups.describeDue(existing.due) });
    const pick = await vscode.window.showQuickPick(items, {
      title: `Follow up on "${truncate(s.title, 50)}"`,
      placeHolder: existing ? `Currently ${followups.describeDue(existing.due)}${existing.note ? `: ${existing.note}` : ''}` : 'When should I remind you?',
    });
    if (!pick) return;
    if (pick.clear) { await setFollowup(s, null); return; }
    let due = pick.d;
    if (pick.custom === 'days') {
      const v = await vscode.window.showInputBox({
        prompt: 'Remind me in how many days?', value: '5', ignoreFocusOut: true,
        validateInput: (x) => (/^\d{1,3}$/.test(x.trim()) && +x > 0 ? null : 'Enter a number of days, e.g. 5'),
      });
      if (!v) return;
      due = followups.addDays(today, parseInt(v, 10));
    } else if (pick.custom === 'date') {
      const v = await vscode.window.showInputBox({
        prompt: 'Remind me on (YYYY-MM-DD)', value: followups.toDateKey(followups.addDays(today, 1)), ignoreFocusOut: true,
        validateInput: (x) => {
          const d = followups.parseDateKey(x);
          if (!d) return 'Use the format YYYY-MM-DD, e.g. 2026-12-01';
          return followups.daysUntil(x.trim(), today) < 0 ? 'That date is in the past' : null;
        },
      });
      if (!v) return;
      due = followups.parseDateKey(v);
    }
    const dueKey = followups.toDateKey(due);
    const note = await vscode.window.showInputBox({
      title: `Follow-up on ${followups.formatDay(due)}`,
      prompt: 'Note for the reminder (optional). Press Enter or Escape to skip.',
      placeHolder: 'e.g. check the deploy, reply to review comments',
      value: existing ? existing.note : '',
      ignoreFocusOut: true,
    });
    // Escape on the optional note keeps the follow-up (without a note) instead of discarding the chosen date.
    const text = note === undefined ? (existing ? existing.note : '') : note.trim();
    await setFollowup(s, {
      due: dueKey,
      note: text,
      title: s.title,
      cwd: s.cwd,
      createdAt: new Date().toISOString(),
      notifiedOn: null,
    });
    const change = await vscode.window.showInformationMessage(
      `🔔 Follow-up set for ${followups.formatDay(due)}${followups.daysUntil(dueKey) < 7 ? ` (${followups.describeDue(dueKey)})` : ''}: ${truncate(s.title, 50)}${text ? `: ${text}` : ''}`,
      'Change');
    if (change === 'Change') vscode.commands.executeCommand('claudeSessions.setFollowup', { s });
  });

  reg('claudeSessions.clearFollowup', async (arg) => {
    const s = sessionFrom(arg, provider, view);
    if (s) await setFollowup(s, null);
  });


  reg('claudeSessions.pin', async (arg, sel) => {
    const list = sessionsFrom(arg, sel, provider, view);
    await patchMarks(list, { pinned: true, archivedAt: null });
  });
  reg('claudeSessions.unpin', async (arg, sel) => {
    await patchMarks(sessionsFrom(arg, sel, provider, view), { pinned: false });
  });

  reg('claudeSessions.rename', async (arg) => {
    const s = sessionFrom(arg, provider, view);
    if (!s) return;
    const v = await vscode.window.showInputBox({
      title: 'Rename session',
      prompt: `Shown in this sidebar only; Claude Code's own title stays "${truncate(s.baseTitle || s.title, 60)}". Leave empty to go back to it.`,
      value: s.title,
      valueSelection: [0, s.title.length],
      ignoreFocusOut: true,
    });
    if (v === undefined) return;
    const name = v.trim().slice(0, 120);
    await patchMarks([s], { name: name && name !== s.baseTitle ? name : null });
    detailCache.delete(s.file); // the conversation view's heading shows the title
    provider.refresh();
  });

  reg('claudeSessions.editNote', async (arg) => {
    const s = sessionFrom(arg, provider, view);
    if (!s) return;
    const cur = (provider.marks()[s.id] || {}).note || '';
    const v = await vscode.window.showInputBox({
      title: `Note for "${truncate(s.title, 50)}"`,
      prompt: 'Shown under the session and on hover. Leave empty to remove the note.',
      placeHolder: 'e.g. step 2 of 4 done, next: tests',
      value: cur,
      ignoreFocusOut: true,
    });
    if (v === undefined) return;
    await patchMarks([s], { note: v.trim().slice(0, 300) || null });
  });

  reg('claudeSessions.setLabels', async (arg, sel) => {
    const list = sessionsFrom(arg, sel, provider, view);
    if (!list.length) return;
    const map = provider.marks();
    const labelsOf = (s) => (map[s.id] && map[s.id].labels) || [];
    // Labels every chosen session already has start checked; others are left alone unless checked.
    const initial = labelsOf(list[0]).filter((l) => list.every((s) => labelsOf(s).includes(l)));
    const known = [...new Set([...marks.allLabels(map), ...initial])];
    const qp = vscode.window.createQuickPick();
    qp.canSelectMany = true;
    qp.ignoreFocusOut = true;
    qp.title = `Labels for ${many(list)}`;
    qp.placeholder = known.length ? 'Check labels, or type a new one and press Enter' : 'Type a label (e.g. bug, feature, research) and press Enter';
    const base = known.map((l) => ({ label: `#${l}`, l }));
    qp.items = base;
    qp.selectedItems = base.filter((it) => initial.includes(it.l));
    qp.onDidChangeValue((v) => {
      const n = marks.normalizeLabel(v);
      const keep = qp.selectedItems;
      const extra = n && !known.includes(n) ? [{ label: `$(add) #${n}`, description: 'new label', l: n, alwaysShow: true }] : [];
      qp.items = [...extra, ...base];
      qp.selectedItems = qp.items.filter((it) => keep.some((k) => k.l === it.l));
    });
    const chosen = await new Promise((resolve) => {
      qp.onDidAccept(() => {
        const set = new Set(qp.selectedItems.map((it) => it.l));
        // Typing a brand-new label and pressing Enter adds it without having to check it first.
        const n = marks.normalizeLabel(qp.value);
        if (n && (known.includes(n) || !known.some((l) => l.includes(n)))) set.add(n);
        resolve(set);
        qp.hide();
      });
      qp.onDidHide(() => resolve(null));
      qp.show();
    });
    qp.dispose();
    if (!chosen) return;
    const removed = initial.filter((l) => !chosen.has(l));
    await patchMarks(list, (m) => {
      const next = (m.labels || []).filter((l) => !removed.includes(l));
      for (const l of chosen) if (!next.includes(l)) next.push(l);
      return { labels: next };
    });
  });

  reg('claudeSessions.filterByLabel', async () => {
    const map = provider.marks();
    const labels = marks.allLabels(map);
    if (!labels.length) { vscode.window.showInformationMessage('No labels yet. Right-click a session and choose Set Labels… to add one.'); return; }
    const count = (l) => Object.values(map).filter((m) => (m.labels || []).includes(l)).length;
    const pick = await vscode.window.showQuickPick(labels.map((l) => ({ label: `#${l}`, description: `${count(l)} session${count(l) === 1 ? '' : 's'}`, l })), { title: 'Show sessions with label' });
    if (pick) setFilter(`#${pick.l}`);
  });

  // ---------- archive & delete ----------
  reg('claudeSessions.archive', async (arg, sel) => {
    const list = sessionsFrom(arg, sel, provider, view);
    if (!list.length) return;
    await patchMarks(list, { archivedAt: Date.now(), pinned: false, unarchivedAt: null });
    const undo = await vscode.window.showInformationMessage(
      `Archived ${many(list)}. ${provider.showArchived ? '' : 'Use Show Archived in the ⋯ menu to see archived sessions. '}Resuming a session brings it back.`, 'Undo');
    if (undo === 'Undo') await patchMarks(list, { archivedAt: null });
  });
  reg('claudeSessions.unarchive', async (arg, sel) => {
    await patchMarks(sessionsFrom(arg, sel, provider, view), { archivedAt: null, unarchivedAt: Date.now() });
  });
  const setShowArchived = async (v) => {
    await context.globalState.update(SHOW_ARCHIVED_KEY, v);
    vscode.commands.executeCommand('setContext', 'claudeSessions.showArchived', v);
    provider._em.fire();
  };
  reg('claudeSessions.showArchived', () => setShowArchived(true));
  reg('claudeSessions.hideArchived', () => setShowArchived(false));

  reg('claudeSessions.delete', async (arg, sel) => {
    const list = sessionsFrom(arg, sel, provider, view);
    if (!list.length) return;
    provider.refreshRunning();
    const open = list.filter((s) => provider.running.has(s.id));
    if (open.length) {
      vscode.window.showWarningMessage(`${many(open)} ${open.length === 1 ? 'is' : 'are'} still open in a terminal. Exit Claude there first, then delete.`);
      return;
    }
    const names = list.slice(0, 8).map((s) => `• ${truncate(s.title, 70)}`).join('\n') + (list.length > 8 ? `\n…and ${list.length - 8} more` : '');
    const ok = await vscode.window.showWarningMessage(
      `Delete ${many(list)}?`,
      { modal: true, detail: `${names}\n\nThe conversation files are moved to the ${TRASH}, so you can restore them from there. After deleting, the session can no longer be resumed.\n\nTo just hide a session, use Archive instead.` },
      `Move to ${TRASH}`, 'Archive Instead');
    if (ok === 'Archive Instead') { vscode.commands.executeCommand('claudeSessions.archive', { s: list[0] }, list.map((s) => ({ kind: 'session', s }))); return; }
    if (ok !== `Move to ${TRASH}`) return;
    const failed = [];
    for (const s of list) {
      const targets = [
        s.file, // the conversation
        path.join(path.dirname(s.file), s.id), // subagent transcripts and large tool results
        path.join(CLAUDE_DIR, 'file-history', s.id), // file backups used by /rewind
        path.join(CLAUDE_DIR, 'session-env', s.id),
      ];
      try {
        for (const t of targets) {
          if (fs.existsSync(t)) await vscode.workspace.fs.delete(vscode.Uri.file(t), { recursive: true, useTrash: true });
        }
      } catch (e) {
        failed.push(`${truncate(s.title, 40)}: ${e.message}`);
        continue;
      }
      cache.delete(s.file);
      detailCache.delete(s.file);
    }
    const gone = new Set(list.filter((s) => !fs.existsSync(s.file)).map((s) => s.id));
    let mk = provider.marks();
    for (const id of gone) mk = marks.remove(mk, id);
    await provider.setMarks(mk);
    const fu = { ...provider.followups() };
    for (const id of gone) delete fu[id];
    await provider.setFollowups(fu);
    if (provider.contentFilter) for (const id of gone) provider.contentFilter.ids.delete(id);
    provider.refresh();
    updateStatus();
    if (failed.length) vscode.window.showErrorMessage(`Could not delete: ${failed.join('; ')}`);
    else vscode.window.setStatusBarMessage(`Moved ${gone.size} session${gone.size === 1 ? '' : 's'} to the ${TRASH}`, 4000);
  });

};
