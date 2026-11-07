// Reads Claude Code's live session registry (~/.claude/sessions/<pid>.json).
// Pure Node (no vscode dependency).
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const SESSIONS_DIR = path.join(require('./paths').CLAUDE_DIR, 'sessions');

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Returns Map<sessionId, { pid, status, waitingFor, cwd, name, startedAt, updatedAt }>
// status: 'busy' (working), 'waiting' (needs input), 'idle' (open, nothing happening)
function readRunning(dir = SESSIONS_DIR, alive = isAlive) {
  const out = new Map();
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /^\d+\.json$/.test(f)); } catch { return out; }
  for (const f of files) {
    let o;
    try { o = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    if (!o || !o.sessionId || !alive(o.pid)) continue;
    const entry = {
      pid: o.pid,
      status: ['busy', 'waiting', 'idle'].includes(o.status) ? o.status : 'idle',
      waitingFor: o.waitingFor || '',
      cwd: o.cwd || '',
      name: o.name || '',
      startedAt: o.startedAt ? new Date(o.startedAt) : null,
      updatedAt: o.updatedAt ? new Date(o.updatedAt) : null,
    };
    const prev = out.get(o.sessionId);
    // Same session open twice: keep the most "urgent" / most recent entry.
    if (!prev || rank(entry) > rank(prev) || (rank(entry) === rank(prev) && (entry.updatedAt || 0) > (prev.updatedAt || 0))) {
      out.set(o.sessionId, entry);
    }
  }
  return out;
}

const RANK = { waiting: 3, busy: 2, idle: 1 };
const rank = (e) => RANK[e.status] || 0;

const STATUS_LABEL = { busy: 'Working', waiting: 'Needs input', idle: 'Open' };

function parentPid(pid) {
  try {
    const out = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 }).trim();
    const n = parseInt(out, 10);
    return Number.isInteger(n) ? n : null;
  } catch { return null; }
}

module.exports = { SESSIONS_DIR, readRunning, isAlive, parentPid, STATUS_LABEL, rank };
