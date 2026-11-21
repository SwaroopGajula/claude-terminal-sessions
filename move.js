// Moving or copying a session to another folder, and relinking sessions after a folder moved.
// No vscode dependency.
//
// Claude Code finds a session by the folder it started in: ~/.claude/projects/<folder, encoded>/<id>.jsonl.
// Moving rewrites the paths recorded inside the session (and its agents) and puts it under the new folder.
const fs = require('fs');
const path = require('path');
const share = require('./share');
const { CLAUDE_DIR } = require('./paths');

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Replace `from` with `to` wherever it appears as a whole path (or the start of one) inside a string.
function replacePath(str, from, to) {
  if (!from || !str.includes(from)) return str;
  const re = new RegExp(`${escapeRe(from)}(?=$|[\\\\/\\s"'\`:;,)\\]}>|])`, 'g');
  return str.replace(re, () => to);
}

// Walk a parsed JSON value, rewriting paths in all strings (keys too) and the session ID where recorded.
function rewriteValue(v, from, to, ids) {
  if (typeof v === 'string') return replacePath(v, from, to);
  if (Array.isArray(v)) return v.map((x) => rewriteValue(x, from, to, ids));
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      const key = replacePath(k, from, to);
      out[key] = ids && k === 'sessionId' && x === ids.oldId ? ids.newId : rewriteValue(x, from, to, ids);
    }
    return out;
  }
  return v;
}

// Rewrite a .jsonl transcript (or a single .json file). Lines that aren't JSON are kept unchanged.
function rewriteText(text, from, to, ids) {
  return text.split('\n').map((line) => {
    if (!line.trim()) return line;
    try { return JSON.stringify(rewriteValue(JSON.parse(line), from, to, ids)); } catch { return line; }
  }).join('\n');
}

function copyTree(src, dest, transform) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const a = path.join(src, e.name);
    const b = path.join(dest, e.name);
    if (e.isDirectory()) copyTree(a, b, transform);
    else if (transform && /\.jsonl?$/.test(e.name)) fs.writeFileSync(b, transform(fs.readFileSync(a, 'utf8')));
    else fs.copyFileSync(a, b);
  }
}

// Where the session would go. `from`/`to` are the path prefix to rewrite (default: its folder -> newCwd).
// `claudeDir` defaults to Claude Code's folder (tests pass a temporary one).
const projectDir = (claudeDir, cwd) => path.join(claudeDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));

function plan(s, newCwd, { copy = false, newId, from, to, claudeDir = CLAUDE_DIR } = {}) {
  const id = copy ? (newId || share.newSessionId()) : s.id;
  const dir = projectDir(claudeDir, newCwd);
  return {
    id,
    copy,
    from: from || s.cwd,
    to: to || newCwd,
    fromFile: s.file,
    toFile: path.join(dir, `${id}.jsonl`),
    fromSide: path.join(path.dirname(s.file), s.id),
    toSide: path.join(dir, id),
  };
}

// Move or copy one session. Returns { id, file }. The original is removed only after the new copy is written.
function moveSession(s, newCwd, opts = {}) {
  const p = plan(s, newCwd, opts);
  if (path.resolve(p.toFile) === path.resolve(p.fromFile)) throw new Error('The session is already in that folder.');
  if (fs.existsSync(p.toFile)) throw new Error('A session with the same ID already exists in that folder.');
  const ids = p.copy ? { oldId: s.id, newId: p.id } : null;
  const transform = (text) => rewriteText(text, p.from, p.to, ids);
  fs.mkdirSync(path.dirname(p.toFile), { recursive: true });
  const written = [];
  try {
    fs.writeFileSync(p.toFile, transform(fs.readFileSync(p.fromFile, 'utf8')));
    written.push(p.toFile);
    if (fs.existsSync(p.fromSide)) { copyTree(p.fromSide, p.toSide, transform); written.push(p.toSide); }
    if (p.copy) {
      // Keep file backups for the copy too, so its diffs and /rewind still work.
      const base = opts.claudeDir || CLAUDE_DIR;
      const hist = path.join(base, 'file-history', s.id);
      const histCopy = path.join(base, 'file-history', p.id);
      if (fs.existsSync(hist)) { copyTree(hist, histCopy); written.push(histCopy); }
    }
  } catch (e) {
    for (const w of written) { try { fs.rmSync(w, { recursive: true, force: true }); } catch { /* best effort */ } }
    throw e;
  }
  if (!p.copy) {
    fs.rmSync(p.fromFile, { force: true });
    if (fs.existsSync(p.fromSide)) fs.rmSync(p.fromSide, { recursive: true, force: true });
  }
  return { id: p.id, file: p.toFile };
}

// Is `p` the folder `root` or inside it?
function isInside(p, root) {
  if (p === root) return true;
  return p.startsWith(root) && (p[root.length] === '/' || p[root.length] === '\\');
}

// After a folder moved: move every session started in `oldRoot` (or below it) to the same place under `newRoot`.
// Also carries over Claude Code's per-project memory folder when the new place doesn't have one.
function relink(sessions, oldRoot, newRoot, isRunning = () => false, opts = {}) {
  const moved = [];
  const failed = [];
  const sourceDirs = new Set();
  for (const s of sessions) {
    if (!isInside(s.cwd, oldRoot)) continue;
    if (isRunning(s)) { failed.push({ s, error: 'open in a terminal' }); continue; }
    const newCwd = newRoot + s.cwd.slice(oldRoot.length);
    try {
      const r = moveSession(s, newCwd, { ...opts, from: oldRoot, to: newRoot });
      moved.push({ s, ...r, cwd: newCwd });
      sourceDirs.add(path.dirname(s.file));
    } catch (e) { failed.push({ s, error: e.message }); }
  }
  for (const dir of sourceDirs) {
    const mem = path.join(dir, 'memory');
    const rel = moved.find((m) => path.dirname(m.s.file) === dir);
    const target = rel && path.join(path.dirname(rel.file), 'memory');
    try {
      if (target && fs.existsSync(mem) && !fs.existsSync(target)) fs.renameSync(mem, target);
      if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
    } catch { /* leave it */ }
  }
  return { moved, failed };
}

// The folder itself and its parents that don't exist anymore (candidates for "this folder moved").
function missingRoots(cwd, exists = fs.existsSync) {
  const out = [];
  let p = cwd;
  while (p && !exists(p)) {
    out.push(p);
    const up = path.dirname(p);
    if (up === p) break;
    p = up;
  }
  return out;
}

module.exports = { replacePath, rewriteText, plan, moveSession, relink, missingRoots, isInside };
