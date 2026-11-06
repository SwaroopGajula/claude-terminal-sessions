// Unit tests for running.js, followups.js and summary.js (all data here is invented).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const running = require('../running');
const fu = require('../followups');
const summary = require('../summary');

// ---------- running ----------

test('readRunning keeps live sessions and the most urgent status', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cts-run-'));
  const write = (pid, o) => fs.writeFileSync(path.join(dir, `${pid}.json`), JSON.stringify({ pid, ...o }));
  write(101, { sessionId: 'aaa', status: 'idle', cwd: '/projects/my-web-app', updatedAt: 1 });
  write(102, { sessionId: 'aaa', status: 'waiting', waitingFor: 'input needed', updatedAt: 2 });
  write(103, { sessionId: 'bbb', status: 'busy' });
  write(104, { sessionId: 'ccc', status: 'busy' }); // dead process
  fs.writeFileSync(path.join(dir, '105.json'), '{broken');
  fs.writeFileSync(path.join(dir, '106.secret.key'), 'not json');
  const m = running.readRunning(dir, (pid) => pid !== 104);
  assert.deepStrictEqual([...m.keys()].sort(), ['aaa', 'bbb']);
  assert.strictEqual(m.get('aaa').status, 'waiting');
  assert.strictEqual(m.get('aaa').pid, 102);
  assert.strictEqual(m.get('bbb').status, 'busy');
});

test('readRunning returns empty when the folder is missing', () => {
  assert.strictEqual(running.readRunning('/nonexistent/cts').size, 0);
});

// ---------- follow-ups ----------

const WED = new Date(2026, 10, 4, 15, 30); // Wed Nov 4 2026, 3:30 PM

test('date helpers', () => {
  assert.strictEqual(fu.toDateKey(WED), '2026-11-04');
  assert.strictEqual(fu.toDateKey(fu.addDays(WED, 1)), '2026-11-05');
  assert.strictEqual(fu.toDateKey(fu.addDays(WED, 30)), '2026-12-04');
  assert.strictEqual(fu.toDateKey(fu.nextWeekday(WED, 1)), '2026-11-09'); // next Monday
  assert.strictEqual(fu.parseDateKey('2026-02-31'), null);
  assert.strictEqual(fu.parseDateKey('nope'), null);
});

test('due logic and wording', () => {
  assert.strictEqual(fu.daysUntil('2026-11-04', WED), 0);
  assert.strictEqual(fu.describeDue('2026-11-04', WED), 'due today');
  assert.strictEqual(fu.describeDue('2026-11-05', WED), 'due tomorrow');
  assert.strictEqual(fu.describeDue('2026-11-07', WED), 'due in 3 days');
  assert.strictEqual(fu.describeDue('2026-11-03', WED), 'overdue since yesterday');
  assert.strictEqual(fu.describeDue('2026-11-01', WED), 'overdue 3 days');
  assert.ok(fu.isDue({ due: '2026-11-04' }, WED));
  assert.ok(!fu.isDue({ due: '2026-11-05' }, WED));
});

test('toNotify returns due follow-ups not yet announced today', () => {
  const map = {
    s1: { due: '2026-11-04', notifiedOn: null },
    s2: { due: '2026-11-02', notifiedOn: '2026-11-04' }, // already announced today
    s3: { due: '2026-11-01', notifiedOn: '2026-11-03' }, // announced yesterday -> again today
    s4: { due: '2026-11-10' },
  };
  assert.deepStrictEqual(fu.toNotify(map, WED).map(([id]) => id), ['s3', 's1']);
});

// ---------- summary: git activity ----------

test('commitMessages handles -m, heredoc and -F -', () => {
  assert.deepStrictEqual(summary.commitMessages('git add . && git commit -m "feat: add dark mode toggle"'), ['feat: add dark mode toggle']);
  assert.deepStrictEqual(summary.commitMessages("git commit -q -m 'fix: typo in footer'"), ['fix: typo in footer']);
  assert.deepStrictEqual(summary.commitMessages('git commit -m "$(cat <<\'EOF\'\nfeat: theme switcher\n\nLonger body\nEOF\n)"'), ['feat: theme switcher']);
  assert.deepStrictEqual(summary.commitMessages("git commit -F - <<'EOF'\ndocs: update README\n\nbody\nEOF"), ['docs: update README']);
  assert.deepStrictEqual(summary.commitMessages('git commit --amend --no-edit'), ['(amended previous commit)']);
  assert.deepStrictEqual(summary.commitMessages('git status && git log --oneline'), []);
});

test('prTitles and isPush', () => {
  assert.deepStrictEqual(summary.prTitles('gh pr create --title "Add dark mode" --body "..."'), ['Add dark mode']);
  assert.ok(summary.isPush('git push -u origin feature/dark-mode'));
  assert.ok(!summary.isPush('git pull'));
});

// ---------- summary: report ----------

test('ranges: last working day skips the weekend', () => {
  const mon = new Date(2026, 10, 9, 10);
  assert.strictEqual(summary.ranges(mon).lastWorkday.from.getDay(), 5); // Friday
  assert.strictEqual(summary.ranges(WED).lastWorkday.from.getDate(), 3); // Tuesday
});

test('buildSummary only counts activity inside the range', () => {
  const t = (d, h) => new Date(2026, 10, d, h);
  const s = { id: 'x', title: 'dark-mode-toggle', cwd: '/projects/my-web-app', gitBranch: 'feature/dark-mode' };
  const d = {
    prompts: [{ text: 'Add a dark mode toggle', time: t(3, 10) }, { text: 'Write tests for the toggle', time: t(4, 11) }],
    commands: [
      { cmd: 'git commit -m "feat: dark mode toggle"', time: t(3, 12), failed: false },
      { cmd: 'git commit -m "test: toggle tests"', time: t(4, 12), failed: false },
      { cmd: 'git commit -m "wip: broken"', time: t(4, 12), failed: true },
      { cmd: 'git push', time: t(4, 13), failed: false },
    ],
    edits: [{ path: '/projects/my-web-app/src/ThemeToggle.tsx', time: t(3, 11) }, { path: '/projects/my-web-app/src/ThemeToggle.test.tsx', time: t(4, 11) }],
  };
  const r = summary.buildSummary([{ s, d }], { ...summary.dayRange(t(4, 0)), label: 'Yesterday' });
  assert.strictEqual(r.count, 1);
  assert.match(r.markdown, /1 session · 1 prompt · 1 file changed · 1 commit/);
  assert.match(r.markdown, /Write tests for the toggle/);
  assert.doesNotMatch(r.markdown, /Add a dark mode toggle/);
  assert.match(r.markdown, /\*\*Commits \(pushed\):\*\*\n- `test: toggle tests`/);
  assert.doesNotMatch(r.markdown, /wip: broken/);
  assert.match(r.markdown, /`src\/ThemeToggle\.test\.tsx`/);

  const empty = summary.buildSummary([{ s, d }], summary.dayRange(t(10, 0)));
  assert.strictEqual(empty.count, 0);
});
