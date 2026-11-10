// Pins, notes, labels and archive state for sessions. Pure (no vscode dependency).
// Stored by the extension (never in Claude's files) as { [sessionId]: { name, pinned, note, labels, archivedAt } }.

const EMPTY = (m) => !m.name && !m.pinned && !m.note && !(m.labels && m.labels.length) && !m.archivedAt && !m.unarchivedAt;

// Returns a new map with `patch` merged into the session's entry; empty entries are removed.
function update(map, id, patch) {
  const next = { ...(map || {}) };
  const m = { ...(next[id] || {}), ...patch };
  for (const k of Object.keys(m)) if (m[k] === undefined || m[k] === null || m[k] === '' || m[k] === false) delete m[k];
  if (m.labels && !m.labels.length) delete m.labels;
  if (EMPTY(m)) delete next[id]; else next[id] = m;
  return next;
}

function remove(map, id) {
  const next = { ...(map || {}) };
  delete next[id];
  return next;
}

// "Bug Fix!" -> "bug-fix"
function normalizeLabel(s) {
  return String(s || '').toLowerCase().trim().replace(/^#+/, '').replace(/[^a-z0-9._/-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
}

// All labels in use, most used first
function allLabels(map) {
  const n = new Map();
  for (const m of Object.values(map || {})) for (const l of m.labels || []) n.set(l, (n.get(l) || 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([l]) => l);
}

// Archived explicitly (and not used since), or idle longer than autoDays (unless pinned or followed up).
// unarchivedAt restarts the idle clock so an auto-archived session that was brought back stays visible.
function isArchived(s, m, { autoDays = 0, hasFollowup = false, now = Date.now() } = {}) {
  const updated = s.updated ? s.updated.getTime() : 0;
  if (m && m.archivedAt) return updated <= m.archivedAt; // resuming a session brings it back
  if (autoDays > 0 && !(m && m.pinned) && !hasFollowup) {
    return now - Math.max(updated, (m && m.unarchivedAt) || 0) > autoDays * 86400000;
  }
  return false;
}

// Filter text: plain words match title/prompts/folder/branch/ID/note/labels; "#label" must match a label exactly.
function matchesFilter(s, m, filter) {
  const words = String(filter || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const labels = (m && m.labels) || [];
  const hay = [s.title, s.baseTitle, s.firstPrompt, s.lastPrompt, s.cwd, s.id, s.gitBranch, m && m.note, ...labels]
    .filter(Boolean).join('\n').toLowerCase();
  return words.every((w) => (w.startsWith('#') && w.length > 1 ? labels.includes(normalizeLabel(w)) : hay.includes(w)));
}

module.exports = { update, remove, normalizeLabel, allLabels, isArchived, matchesFilter };
