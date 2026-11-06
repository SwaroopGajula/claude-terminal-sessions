// Daily summary ("what did I work on?") built from session details. Pure (no vscode dependency).
const path = require('path');
const os = require('os');

// ---------- git activity from shell commands ----------

function firstLine(s) {
  return String(s || '').split('\n').map((l) => l.trim()).find((l) => l) || '';
}

// Commit messages in a shell command (handles -m "..", -m '..', heredocs and -F - <<EOF)
function commitMessages(cmd) {
  const out = [];
  const re = /\bgit\b(?:\s+-[cC]\s+\S+)*\s+commit\b/g;
  let m;
  while ((m = re.exec(cmd))) {
    const rest = cmd.slice(m.index);
    const heredoc = /<<-?\s*['"]?(\w+)['"]?[^\n]*\n([\s\S]*?)\n\s*\1\b/.exec(rest);
    const dashM = /\s-(?:m|-message)(?:\s+|=)(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+))/.exec(rest);
    let msg = '';
    if (heredoc && (!dashM || heredoc.index < dashM.index || /\$\(cat\s*<</.test(rest.slice(0, heredoc.index + 20)))) msg = heredoc[2];
    else if (dashM) msg = dashM[1] !== undefined ? dashM[1].replace(/\\(.)/g, '$1') : (dashM[2] !== undefined ? dashM[2] : dashM[3]);
    if (/^--amend\b/.test(rest.slice(m[0].length).trim()) && !msg) msg = '(amended previous commit)';
    msg = firstLine(msg);
    if (msg && !msg.startsWith('$(')) out.push(msg);
  }
  return out;
}

function prTitles(cmd) {
  const out = [];
  const re = /\bgh\s+pr\s+create\b[^\n]*?--title(?:\s+|=)(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(cmd))) out.push((m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2]).trim());
  return out;
}

const isPush = (cmd) => /\bgit\b(?:\s+-[cC]\s+\S+)*\s+push\b/.test(cmd);

// ---------- ranges ----------

function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }

function ranges(now = new Date()) {
  const today = startOfDay(now);
  const day = (n) => { const d = new Date(today); d.setDate(d.getDate() + n); return d; };
  // Last working day: Friday when today is Saturday/Sunday/Monday
  const dow = today.getDay();
  const back = dow === 1 ? 3 : dow === 0 ? 2 : 1;
  const monday = day(-((dow + 6) % 7));
  return {
    today: { label: 'Today', from: today, to: day(1) },
    yesterday: { label: 'Yesterday', from: day(-1), to: today },
    lastWorkday: { label: 'Last working day', from: day(-back), to: day(-back + 1) },
    thisWeek: { label: 'This week', from: monday, to: day(1) },
    last7: { label: 'Last 7 days', from: day(-6), to: day(1) },
  };
}

function dayRange(date) {
  const from = startOfDay(date);
  const to = new Date(from); to.setDate(to.getDate() + 1);
  return { from, to };
}

// ---------- summary ----------

const inRange = (t, from, to) => t && t >= from && t < to;
const short = (p) => (p.startsWith(os.homedir()) ? '~' + p.slice(os.homedir().length) : p);
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const timeOf = (d) => d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

// Activity of one session inside [from, to)
function sessionActivity(s, d, from, to) {
  const prompts = d.prompts.filter((p) => inRange(p.time, from, to));
  const commands = d.commands.filter((c) => inRange(c.time, from, to) && !c.failed);
  const edits = (d.edits || []).filter((e) => inRange(e.time, from, to));
  if (!prompts.length && !commands.length && !edits.length) return null;
  const times = [...prompts, ...commands, ...edits].map((x) => x.time).sort((a, b) => a - b);
  const commits = [];
  const prs = [];
  let pushed = false;
  for (const c of commands) {
    for (const m of commitMessages(c.cmd)) if (!commits.includes(m)) commits.push(m);
    for (const t of prTitles(c.cmd)) if (!prs.includes(t)) prs.push(t);
    if (isPush(c.cmd)) pushed = true;
  }
  const files = [...new Set(edits.map((e) => e.path))];
  return { s, prompts, commands, files, commits, prs, pushed, start: times[0], end: times[times.length - 1] };
}

function buildSummary(items, { from, to, label }) {
  // items: [{ s, d }] where d = session details
  const acts = items.map(({ s, d }) => d && sessionActivity(s, d, from, to)).filter(Boolean);
  const lastDay = new Date(to - 1);
  const sameDay = from.toDateString() === lastDay.toDateString();
  const dateText = sameDay
    ? from.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
    : `${from.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${lastDay.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
  const L = [];
  L.push(`# Claude Code summary: ${label ? label + ', ' : ''}${dateText}`);
  L.push('');
  if (!acts.length) {
    L.push('_No Claude Code activity in this period._');
    return { markdown: L.join('\n') + '\n', count: 0 };
  }
  const total = (k) => acts.reduce((n, a) => n + a[k].length, 0);
  const n = (k, one, many) => `${total(k)} ${total(k) === 1 ? one : many}`;
  L.push(`_${acts.length} session${acts.length === 1 ? '' : 's'} · ${n('prompts', 'prompt', 'prompts')} · ${n('files', 'file changed', 'files changed')} · ${n('commits', 'commit', 'commits')}${total('prs') ? ` · ${n('prs', 'PR', 'PRs')}` : ''}_`);

  const byFolder = new Map();
  for (const a of acts.sort((x, y) => x.start - y.start)) {
    if (!byFolder.has(a.s.cwd)) byFolder.set(a.s.cwd, []);
    byFolder.get(a.s.cwd).push(a);
  }
  for (const [cwd, list] of byFolder) {
    L.push('');
    L.push(`## ${path.basename(cwd)}`);
    L.push(`\`${short(cwd)}\``);
    for (const a of list) {
      L.push('');
      L.push(`### ${a.s.title}`);
      const span = sameDay ? `${timeOf(a.start)} – ${timeOf(a.end)}` : `${a.start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${a.end.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
      L.push(`${a.s.gitBranch ? `Branch \`${a.s.gitBranch}\` · ` : ''}${span} · ${a.prompts.length} prompt${a.prompts.length === 1 ? '' : 's'}`);
      L.push('');
      if (a.prompts.length) {
        L.push('**Asked:**');
        for (const p of a.prompts.slice(0, 5)) L.push(`- ${clip(p.text, 160)}`);
        if (a.prompts.length > 5) L.push(`- …and ${a.prompts.length - 5} more`);
      }
      if (a.commits.length) {
        L.push(`**Commits${a.pushed ? ' (pushed)' : ''}:**`);
        for (const m of a.commits) L.push(`- \`${m.replace(/`/g, "'")}\``);
      }
      if (a.prs.length) {
        L.push('**Pull requests:**');
        for (const t of a.prs) L.push(`- ${t}`);
      }
      if (a.files.length) {
        const names = a.files.map((f) => (f.startsWith(cwd + path.sep) ? path.relative(cwd, f) : short(f)));
        L.push(`**Files changed (${names.length}):** ${names.slice(0, 12).map((n) => `\`${n}\``).join(', ')}${names.length > 12 ? `, …and ${names.length - 12} more` : ''}`);
      }
    }
  }
  return { markdown: L.join('\n') + '\n', count: acts.length };
}

module.exports = { commitMessages, prTitles, isPush, ranges, dayRange, sessionActivity, buildSummary };
