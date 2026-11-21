// Shared UI helpers: conversation view, cost and context labels, shell commands, selection. Uses vscode.
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

const SCHEME = 'claude-session';
const docProvider = {
  _em: new vscode.EventEmitter(),
  get onDidChange() { return this._em.event; },
  sessions: new Map(), // id -> session
  provideTextDocumentContent(uri) {
    const s = this.sessions.get(path.basename(uri.path, '.md'));
    const d = s && getDetails(s);
    return d ? d.markdown : 'Session not found.';
  },
};

async function openConversation(s, line) {
  docProvider.sessions.set(s.id, s);
  const name = truncate(s.title.replace(/[\\/:*?"<>|]/g, ' '), 50);
  const uri = vscode.Uri.from({ scheme: SCHEME, path: `/${name}/${s.id}.md` });
  docProvider._em.fire(uri);
  let doc = await vscode.workspace.openTextDocument(uri);
  if (doc.languageId !== 'markdown') doc = await vscode.languages.setTextDocumentLanguage(doc, 'markdown');
  const pos = new vscode.Position(line || 0, 0);
  await vscode.window.showTextDocument(doc, {
    preview: true,
    selection: new vscode.Range(pos, pos),
  });
  if (line) {
    const ed = vscode.window.activeTextEditor;
    if (ed) ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.AtTop);
  }
}


// ---------- usage ----------

const usageConfig = () => vscode.workspace.getConfiguration('claudeSessions');
function usageSummary(sessions, range = {}) {
  return usage.summarize(sessions.map((s) => s.usage), { ...range, overrides: usageConfig().get('modelPricing', {}) || {} });
}
const showCost = () => usageConfig().get('showCost', true);
const costLabel = (u) => `≈ ${usage.formatCost(u.cost)}${u.unpriced.length ? '+' : ''}`;

// ---------- context ----------

let compactRange = null; // { min, max, n }: sizes at which Claude Code auto-compacted, across all sessions
function updateCompactRange(list) {
  const sizes = list.flatMap((s) => (s.compactions || []).filter((c) => c.trigger === 'auto' && c.pre).map((c) => c.pre));
  compactRange = sizes.length ? { min: Math.min(...sizes), max: Math.max(...sizes), n: sizes.length } : null;
}
function contextInfo(s) {
  if (!s.context || !s.context.tokens) return null;
  const window = usage.contextWindow(s.context.model);
  return { ...s.context, window, pct: window ? Math.round((s.context.tokens * 100) / window) : null };
}
// Warn when the context nears the model's limit or the smallest size Claude Code has auto-compacted at.
const contextHigh = (c) => (c.pct !== null && c.pct >= 80) || (compactRange && c.tokens >= compactRange.min * 0.9);
const contextShort = (c) => `${contextHigh(c) ? '⚠ ' : ''}context ${usage.formatTokens(c.tokens)}${c.pct !== null ? ` (${c.pct}%)` : ''}`;
function contextLong(c, s) {
  const T = usage.formatTokens;
  const parts = [`Context ${T(c.tokens)}${c.window ? ` of ${T(c.window)} (${c.pct}%)` : ''} on the latest reply`];
  const n = (s.compactions || []).length;
  if (n) parts.push(`compacted ${n}× in this session, last at ${T(s.compactions[n - 1].pre)}`);
  if (compactRange) parts.push(`Claude Code usually compacts your sessions at ${T(compactRange.min)}–${T(compactRange.max)}`);
  return parts.join(' · ');
}


const IS_WIN = process.platform === 'win32';
const TRASH = IS_WIN ? 'Recycle Bin' : 'Trash';
const REVEAL = IS_WIN ? 'Reveal in File Explorer' : process.platform === 'darwin' ? 'Reveal in Finder' : 'Show in Folder';

// "cd <folder> && claude --resume <id>" in the syntax of the user's default terminal shell.
function resumeCommand(s) {
  const bin = vscode.workspace.getConfiguration('claudeSessions').get('claudeCommand', 'claude');
  let shellPath = '';
  try { shellPath = vscode.env.shell; } catch { /* older VS Code or tests */ }
  return shell.cdAndRun(shell.shellKind(process.platform, shellPath), s.cwd, `${bin} --resume ${s.id}`);
}

function sessionFrom(arg, provider, view) {
  if (arg && arg.s) return arg.s;
  const sel = view.selection[0];
  return sel && sel.s;
}

// Sessions a command applies to: every selected session when several are selected (and the
// clicked one is among them), otherwise just the clicked one.
function sessionsFrom(arg, selected, provider, view) {
  const s = sessionFrom(arg, provider, view);
  const many = (Array.isArray(selected) ? selected : []).filter((x) => x && x.kind === 'session').map((x) => x.s);
  if (s && many.length > 1 && many.some((x) => x.id === s.id)) {
    const seen = new Set();
    return many.filter((x) => !seen.has(x.id) && seen.add(x.id));
  }
  return s ? [s] : [];
}

setResumeCommand(resumeCommand);

module.exports = { SCHEME, docProvider, openConversation, usageConfig, usageSummary, showCost, costLabel, updateCompactRange, contextInfo, contextHigh, contextShort, contextLong, IS_WIN, TRASH, REVEAL, resumeCommand, sessionFrom, sessionsFrom };
