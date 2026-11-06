// Follow-up reminders: date helpers and due logic. Pure (no vscode dependency).
// A follow-up: { due: 'YYYY-MM-DD', note, title, cwd, createdAt, notifiedOn }

function pad(n) { return String(n).padStart(2, '0'); }

// Local calendar date as YYYY-MM-DD
function toDateKey(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseDateKey(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || '').trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  // Reject things like 2026-02-31 that roll over
  return d.getFullYear() === Number(m[1]) && d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]) ? d : null;
}

function addDays(from, n) {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  d.setDate(d.getDate() + n);
  return d;
}

// Next given weekday strictly after `from` (1 = Monday)
function nextWeekday(from, weekday) {
  const d = addDays(from, 1);
  while (d.getDay() !== weekday) d.setDate(d.getDate() + 1);
  return d;
}

// Whole calendar days from today to the due date (negative = overdue)
function daysUntil(dueKey, today = new Date()) {
  const due = parseDateKey(dueKey);
  if (!due) return null;
  const t = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((due - t) / 86400000);
}

function isDue(f, today = new Date()) {
  const n = daysUntil(f && f.due, today);
  return n !== null && n <= 0;
}

function describeDue(dueKey, today = new Date()) {
  const n = daysUntil(dueKey, today);
  if (n === null) return '';
  if (n < -1) return `overdue ${-n} days`;
  if (n === -1) return 'overdue since yesterday';
  if (n === 0) return 'due today';
  if (n === 1) return 'due tomorrow';
  if (n < 7) return `due in ${n} days`;
  return `due ${formatDay(parseDateKey(dueKey))}`;
}

function formatDay(d) {
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

// Sorted list of [sessionId, followup], soonest first
function sortedFollowups(map) {
  return Object.entries(map || {}).sort((a, b) => String(a[1].due).localeCompare(String(b[1].due)));
}

// Follow-ups that are due and have not been announced today
function toNotify(map, today = new Date()) {
  const key = toDateKey(today);
  return sortedFollowups(map).filter(([, f]) => isDue(f, today) && f.notifiedOn !== key);
}

module.exports = { toDateKey, parseDateKey, addDays, nextWeekday, daysUntil, isDue, describeDue, formatDay, sortedFollowups, toNotify };
