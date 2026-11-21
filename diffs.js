// What a session changed in each file: content before the session and after Claude's last change.
// No vscode dependency.
//
// Sources:
//  - Edit / Write / MultiEdit tool calls in the transcript (and in its agents' transcripts)
//  - Claude Code's file backups (~/.claude/file-history/<sessionId>/<hash>@v<N>, used by /rewind), listed in
//    the transcript's "file-history-snapshot" records. Version 1 is the file before the session first changed it.
const fs = require('fs');
const path = require('path');
const { CLAUDE_DIR } = require('./paths');

const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);

function readLines(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n'); } catch { return []; }
}

// All file changes of a session, in order, plus the backups Claude Code took.
function collect(sessionFile, sessionId, cwd) {
  const edits = []; // { file, tool, input, time }
  const backups = new Map(); // absolute file -> { hash, existed } (from the first snapshot entry naming it)
  const sources = [sessionFile];
  const subDir = path.join(path.dirname(sessionFile), sessionId, 'subagents');
  try { for (const f of fs.readdirSync(subDir)) if (f.endsWith('.jsonl')) sources.push(path.join(subDir, f)); } catch { /* no agents */ }
  for (const src of sources) {
    for (const line of readLines(src)) {
      if (!line) continue;
      const snap = line.includes('"file-history-snapshot"');
      if (!snap && !(line.includes('"tool_use"') && /"(Edit|Write|MultiEdit)"/.test(line))) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      if (snap && src === sessionFile) {
        const tracked = (o.snapshot && o.snapshot.trackedFileBackups) || {};
        for (const [key, v] of Object.entries(tracked)) {
          const abs = path.isAbsolute(key) ? key : path.join(cwd, key);
          if (backups.has(abs)) continue;
          const name = v && v.backupFileName;
          backups.set(abs, { hash: name ? String(name).split('@')[0] : null, existed: !!name });
        }
        continue;
      }
      if (o.type !== 'assistant' || !o.message || !Array.isArray(o.message.content)) continue;
      const time = o.timestamp ? new Date(o.timestamp) : null;
      for (const b of o.message.content) {
        if (!b || b.type !== 'tool_use' || !FILE_TOOLS.has(b.name) || !b.input || !b.input.file_path) continue;
        edits.push({ file: b.input.file_path, tool: b.name, input: b.input, time });
      }
    }
  }
  edits.sort((a, b) => (a.time || 0) - (b.time || 0));
  return { edits, backups };
}

// Apply one edit to text. Returns the new text, or null if the text to replace isn't there.
function applyEdit(text, e) {
  if (e.tool === 'Write') return typeof e.input.content === 'string' ? e.input.content : null;
  const list = e.tool === 'MultiEdit' ? (e.input.edits || []) : [e.input];
  let t = text;
  for (const x of list) {
    if (typeof x.old_string !== 'string' || typeof x.new_string !== 'string' || t === null) return null;
    if (x.old_string === '') { t = x.new_string + t; continue; } // creating content in an empty file
    if (!t.includes(x.old_string)) return null;
    t = x.replace_all ? t.split(x.old_string).join(x.new_string) : t.replace(x.old_string, () => x.new_string);
  }
  return t;
}

// Undo one edit (for rebuilding "before" from the current file). Write can't be undone.
function undoEdit(text, e) {
  if (e.tool === 'Write') return null;
  const list = e.tool === 'MultiEdit' ? [...(e.input.edits || [])].reverse() : [e.input];
  let t = text;
  for (const x of list) {
    if (typeof x.old_string !== 'string' || typeof x.new_string !== 'string') return null;
    if (x.new_string === '' || !t.includes(x.new_string)) return null;
    t = x.replace_all ? t.split(x.new_string).join(x.old_string) : t.replace(x.new_string, () => x.old_string);
  }
  return t;
}

// Added / removed line counts between two texts (exact for normal file sizes, estimated for huge ones).
function lineStats(a, b) {
  const A = a === '' ? [] : a.split('\n');
  const B = b === '' ? [] : b.split('\n');
  let s = 0;
  while (s < A.length && s < B.length && A[s] === B[s]) s++;
  let ea = A.length, eb = B.length;
  while (ea > s && eb > s && A[ea - 1] === B[eb - 1]) { ea--; eb--; }
  const x = A.slice(s, ea), y = B.slice(s, eb);
  if (!x.length || !y.length) return { added: y.length, removed: x.length };
  if (x.length * y.length > 4e6) return { added: y.length, removed: x.length, estimated: true };
  // Longest common subsequence, two rows.
  let prev = new Array(y.length + 1).fill(0);
  for (let i = 1; i <= x.length; i++) {
    const cur = new Array(y.length + 1).fill(0);
    for (let j = 1; j <= y.length; j++) cur[j] = x[i - 1] === y[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    prev = cur;
  }
  const common = prev[y.length];
  return { added: y.length - common, removed: x.length - common };
}

const SEPARATOR = (i, n) => `\n··· change ${i} of ${n} ···\n`;

// One file's change: { file, before, after, mode: 'exact' | 'approximate' | 'parts', created, added, removed, edits }
function fileChange(file, edits, backup, historyDir) {
  let before = null;
  let source = '';
  if (backup) {
    if (!backup.existed) { before = ''; source = 'backup'; } // the file didn't exist before the session
    else if (backup.hash) {
      try { before = fs.readFileSync(path.join(historyDir, `${backup.hash}@v1`), 'utf8'); source = 'backup'; } catch {
        // No version 1: the file didn't exist yet when Claude first wrote it (its backups start at version 2).
        if (edits[0].tool === 'Write') { before = ''; source = 'created'; }
      }
    }
  }
  if (before === null && edits[0].tool === 'Write' && !fs.existsSync(file)) { before = ''; source = 'created'; }
  if (before === null) {
    // Rebuild from the current file by undoing the edits, newest first.
    let t = null;
    try { t = fs.readFileSync(file, 'utf8'); } catch { /* file gone */ }
    for (let i = edits.length - 1; i >= 0 && t !== null; i--) t = undoEdit(t, edits[i]);
    if (t !== null) { before = t; source = 'rebuilt'; }
  }
  let after = null;
  let failed = 0;
  if (before !== null) {
    after = before;
    for (const e of edits) {
      const next = applyEdit(after, e);
      if (next === null) failed++; else after = next;
    }
  }
  if (before === null || after === null) {
    // Only the changed parts are known.
    const parts = edits.flatMap((e) => (e.tool === 'MultiEdit' ? e.input.edits || [] : [e.tool === 'Write' ? { old_string: '', new_string: e.input.content || '' } : e.input]));
    before = parts.map((x, i) => SEPARATOR(i + 1, parts.length) + (x.old_string || '')).join('\n');
    after = parts.map((x, i) => SEPARATOR(i + 1, parts.length) + (x.new_string || '')).join('\n');
    const st = lineStats(before, after);
    return { file, before, after, mode: 'parts', created: false, added: st.added, removed: st.removed, edits: edits.length };
  }
  const st = lineStats(before, after);
  return {
    file, before, after,
    mode: failed ? 'approximate' : 'exact',
    created: before === '' && source !== 'rebuilt',
    added: st.added, removed: st.removed, edits: edits.length, source,
  };
}

const cache = new Map(); // session file -> { key, result }

// All changed files of a session, in the order they were first changed.
function sessionChanges(s) {
  let key = '';
  try { const st = fs.statSync(s.file); key = `${st.mtimeMs}:${st.size}`; } catch { return []; }
  const c = cache.get(s.file);
  if (c && c.key === key) return c.result;
  const { edits, backups } = collect(s.file, s.id, s.cwd);
  const byFile = new Map();
  for (const e of edits) {
    if (!byFile.has(e.file)) byFile.set(e.file, []);
    byFile.get(e.file).push(e);
  }
  const historyDir = path.join(CLAUDE_DIR, 'file-history', s.id);
  const result = [...byFile].map(([file, list]) => fileChange(file, list, backups.get(file), historyDir));
  cache.set(s.file, { key, result });
  return result;
}

module.exports = { collect, applyEdit, undoEdit, lineStats, fileChange, sessionChanges };
