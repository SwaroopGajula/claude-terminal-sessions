// Alerts: detect when a session starts waiting for input or an agent finishes. Pure Node (no vscode).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// Sessions that started waiting since the previous snapshot (Maps of sessionId -> running entry).
function newlyWaiting(prev, next) {
  const out = [];
  for (const [id, e] of next) {
    if (e.status !== 'waiting') continue;
    const before = prev.get(id);
    if (!before || before.status !== 'waiting' || (e.updatedAt && before.updatedAt && e.updatedAt !== before.updatedAt && e.waitingFor !== before.waitingFor)) {
      out.push(e);
    }
  }
  return out;
}

// Agents that finished since last time. `known` maps "sessionId/agentId" -> finished (updated in place).
// Agents seen for the first time count only if they finished after `since` (ms), so old ones stay quiet.
function newlyFinished(known, sessionId, list, since = 0) {
  const out = [];
  for (const a of list) {
    const key = `${sessionId}/${a.id}`;
    const was = known.get(key);
    if (a.finished && (was === false || (was === undefined && a.lastWrite && a.lastWrite.getTime() > since))) out.push(a);
    known.set(key, a.finished);
  }
  return out;
}

// One alert per event across all VS Code windows: the first window to create the marker file wins.
const MARKER_DIR = path.join(os.tmpdir(), 'claude-terminal-sessions-alerts');

function claimOnce(key, dir = MARKER_DIR) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const name = crypto.createHash('sha1').update(key).digest('hex');
    fs.closeSync(fs.openSync(path.join(dir, name), 'wx'));
    return true;
  } catch (e) {
    return e && e.code === 'EEXIST' ? false : true; // if the folder is unusable, alert rather than stay silent
  }
}

function cleanMarkers(maxAgeMs = 2 * 86400000, dir = MARKER_DIR) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  const now = Date.now();
  for (const n of names) {
    const p = path.join(dir, n);
    try { if (now - fs.statSync(p).mtimeMs > maxAgeMs) fs.unlinkSync(p); } catch { /* ignore */ }
  }
}

module.exports = { newlyWaiting, newlyFinished, claimOnce, cleanMarkers, MARKER_DIR };
