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
    // Earliest start among the processes that have this session open (agents started by any of them are live).
    const starts = [entry.startedAt, prev && prev.firstStartedAt].filter(Boolean);
    entry.firstStartedAt = starts.length ? new Date(Math.min(...starts.map(Number))) : null;
    if (prev && !(rank(entry) > rank(prev) || (rank(entry) === rank(prev) && (entry.updatedAt || 0) > (prev.updatedAt || 0)))) {
      prev.firstStartedAt = entry.firstStartedAt;
      continue;
    }
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
  const [p] = ancestorPids(pid, 1);
  return p || null;
}

// Parent, grandparent, ... of a process (up to `depth`). Used to find the VS Code terminal whose shell
// started Claude Code: on Windows there is often a cmd.exe or node launcher in between.
function ancestorPids(pid, depth = 3, platform = process.platform) {
  const n = Math.trunc(Number(pid));
  if (!Number.isInteger(n) || n <= 0) return [];
  try {
    if (platform === 'win32') {
      const script = `$p=${n}; $o=@(); for($i=0;$i -lt ${depth};$i++){ $q=(Get-CimInstance Win32_Process -Filter "ProcessId=$p").ParentProcessId; if(-not $q){break}; $o+=$q; $p=$q }; $o -join ','`;
      const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 5000, windowsHide: true });
      return out.trim().split(',').map((x) => parseInt(x, 10)).filter((x) => Number.isInteger(x) && x > 0);
    }
    const out = [];
    let cur = n;
    for (let i = 0; i < depth; i++) {
      const p = parseInt(execFileSync('ps', ['-o', 'ppid=', '-p', String(cur)], { encoding: 'utf8', timeout: 2000 }).trim(), 10);
      if (!Number.isInteger(p) || p <= 1) break;
      out.push(p);
      cur = p;
    }
    return out;
  } catch { return []; }
}

module.exports = { SESSIONS_DIR, readRunning, isAlive, parentPid, ancestorPids, STATUS_LABEL, rank };
