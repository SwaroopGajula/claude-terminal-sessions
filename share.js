// Session sharing: secret redaction, export bundles and import rewriting.
// Pure Node (no vscode dependency) so it can be unit-tested.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PROJECTS_DIR = path.join(require('./paths').CLAUDE_DIR, 'projects');
const BUNDLE_FORMAT = 'claude-terminal-sessions/session';
const BUNDLE_VERSION = 1;
const MASK = '[REDACTED]';

// Claude Code stores a folder's sessions in ~/.claude/projects/<path with every non-alphanumeric char as "-">
function projectDirFor(cwd) {
  return path.join(PROJECTS_DIR, cwd.replace(/[^a-zA-Z0-9]/g, '-'));
}

// ---------- redaction ----------
// Every replacement is plain text with no quotes or backslashes, so JSON lines stay valid.
const RULES = [
  ['Private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
  ['GitHub token', /\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{30,})\b/g],
  ['GitLab token', /\bglpat-[A-Za-z0-9_-]{20,}\b/g],
  ['Anthropic key', /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
  ['OpenAI-style key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/g],
  ['AWS access key', /\b(?:AKIA|ASIA|AROA|AIDA)[A-Z0-9]{16}\b/g],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['Stripe key', /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}\b/g],
  ['npm token', /\bnpm_[A-Za-z0-9]{36}\b/g],
  ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
  ['Bearer / Basic auth', /\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]{20,}/g, (m, kind) => `${kind} ${MASK}`],
  ['Password in URL', /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@\/"'\\]+:)[^\s@\/"'\\]{3,}@/gi, (m, pre) => `${pre}${MASK}@`],
  // NAME=value / "name": "value" where NAME ends in a secret word (GITHUB_TOKEN, db_password, apiKey...)
  ['Secret assignment',
    /(\b([A-Za-z][A-Za-z0-9_.-]*)\\?["']?\s*[:=]\s*\\?["']?)([^\s"'\\,;}{)\]]{8,})/g,
    (m, pre, name, val) => (isSecretName(name) && isSecretValue(val) ? `${pre}${MASK}` : m)],
];

function isSecretName(name) {
  const n = name.toLowerCase().replace(/[^a-z]/g, '');
  return /(password|passwd|passphrase|secret|token|apikey|accesskey|privatekey|secretkey|clientsecret|credentials?|pwd)$/.test(n)
    && !/(max|min|count|total|input|output|cache|thinking|usage|length|limit|budget)/.test(n);
}

function isSecretValue(v) {
  if (/^\[REDACTED\]$|^-?\d+(\.\d+)?$|^(true|false|null|undefined|none|string|number|boolean|required|optional)$/i.test(v)) return false;
  if (/^\$\{?|^process\.env|^<|^\{\{|^os\.environ|^env\(|\*{3,}|^x{6,}$|^\.{3}/i.test(v)) return false;
  return /\d/.test(v) || v.length >= 16;
}

// Redact inside every string of a JSON value (keeps the structure valid).
function redactDeep(v, counts) {
  if (typeof v === 'string') {
    const r = redact(v);
    for (const [k, c] of Object.entries(r.counts)) counts[k] = (counts[k] || 0) + c;
    return r.text;
  }
  if (Array.isArray(v)) return v.map((x) => redactDeep(x, counts));
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) {
      if (typeof x === 'string' && isSecretName(k) && isSecretValue(x)) {
        o[k] = MASK;
        counts['Secret field'] = (counts['Secret field'] || 0) + 1;
      } else {
        o[k] = redactDeep(x, counts);
      }
    }
    return o;
  }
  return v;
}

// Claude Code's internal request logs: not part of the conversation, not needed to resume, may hold credentials.
const INTERNAL_TYPES = new Set(['api-request', 'api-request-blob', 'api-request-shape']);

function redactJsonl(text) {
  const counts = {};
  const out = [];
  let dropped = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { const r = redact(line); for (const [k, c] of Object.entries(r.counts)) counts[k] = (counts[k] || 0) + c; out.push(r.text); continue; }
    if (o && INTERNAL_TYPES.has(o.type)) { dropped++; continue; }
    out.push(JSON.stringify(redactDeep(o, counts)));
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return { text: out.join('\n') + '\n', counts, total, dropped };
}

function redact(text) {
  const counts = {};
  let out = text;
  for (const [name, re, fn] of RULES) {
    out = out.replace(re, (...args) => {
      const replaced = fn ? fn(...args) : MASK;
      if (replaced !== args[0]) counts[name] = (counts[name] || 0) + 1;
      return replaced;
    });
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return { text: out, counts, total };
}

function summarizeCounts(counts) {
  return Object.entries(counts).map(([k, v]) => `${v} × ${k}`).join(', ');
}

// ---------- export ----------

function buildBundle(s, version) {
  const raw = fs.readFileSync(s.file, 'utf8');
  const r = redactJsonl(raw);
  const bundle = {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    exportedAt: new Date().toISOString(),
    exportedWith: `claude-terminal-sessions ${version}`,
    session: {
      id: s.id,
      title: s.title,
      cwd: s.cwd,
      folderName: path.basename(s.cwd),
      gitBranch: s.gitBranch || null,
      created: s.created && s.created.toISOString(),
      updated: s.updated && s.updated.toISOString(),
      prompts: s.userMessages,
    },
    redactions: r.counts,
    jsonl: r.text,
  };
  return { json: JSON.stringify(bundle), redaction: r };
}

function readBundle(file) {
  let b;
  try { b = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new Error(`Not a valid session export: ${e.message}`); }
  if (!b || b.format !== BUNDLE_FORMAT || typeof b.jsonl !== 'string' || !b.session || !b.session.id) {
    throw new Error('This file is not a Claude Terminal Sessions export.');
  }
  if (b.version > BUNDLE_VERSION) throw new Error('This export was made by a newer version of the extension. Please update it.');
  if (!/^[0-9a-f-]{36}$/i.test(b.session.id)) throw new Error('The export has an invalid session ID.');
  return b;
}

// ---------- import ----------

function findExisting(id) {
  const hits = [];
  let dirs = [];
  try { dirs = fs.readdirSync(PROJECTS_DIR); } catch { return hits; }
  for (const d of dirs) {
    const f = path.join(PROJECTS_DIR, d, `${id}.jsonl`);
    if (fs.existsSync(f)) hits.push(f);
  }
  return hits;
}

function rewritePath(p, oldCwd, newCwd) {
  if (typeof p !== 'string') return p;
  if (p === oldCwd) return newCwd;
  if (p.startsWith(oldCwd + '/') || p.startsWith(oldCwd + '\\')) {
    // Use the new computer's separator for the rest of the path (e.g. a Mac export imported on Windows).
    const rest = p.slice(oldCwd.length);
    const winTarget = newCwd.includes('\\') && !newCwd.includes('/');
    return newCwd + (winTarget ? rest.replace(/\//g, '\\') : newCwd.includes('/') ? rest.replace(/\\/g, '/') : rest);
  }
  return p;
}

// Rewrites the transcript so it belongs to newCwd (and optionally a new session ID). Returns the new JSONL text.
function rewriteTranscript(jsonl, { oldCwd, newCwd, oldId, newId }) {
  const out = [];
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { out.push(line); continue; }
    if (typeof o.cwd === 'string') o.cwd = rewritePath(o.cwd, oldCwd, newCwd);
    if (o.sessionId === oldId) o.sessionId = newId;
    if (o.attachment && o.attachment.snapshot && typeof o.attachment.snapshot.workingDirectory === 'string') {
      o.attachment.snapshot.workingDirectory = rewritePath(o.attachment.snapshot.workingDirectory, oldCwd, newCwd);
    }
    out.push(JSON.stringify(o));
  }
  return out.join('\n') + '\n';
}

function importBundle(b, newCwd, { newId } = {}) {
  const id = newId || b.session.id;
  const text = rewriteTranscript(b.jsonl, { oldCwd: b.session.cwd, newCwd, oldId: b.session.id, newId: id });
  const dir = projectDirFor(newCwd);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, text, { mode: 0o600 });
  return { id, file };
}

const newSessionId = () => crypto.randomUUID();

module.exports = {
  PROJECTS_DIR, projectDirFor, redact, redactJsonl, summarizeCounts, buildBundle, readBundle,
  findExisting, rewriteTranscript, importBundle, newSessionId,
};
