#!/usr/bin/env node
// Creates invented Claude Code sessions in ~/claude-demo and opens an isolated VS Code window that shows only them.
// Use it to record screenshots or GIFs without exposing real work. Nothing in ~/.claude or your normal VS Code is touched.
//
//   node scripts/demo.js          create the demo data and open the demo window
//   node scripts/demo.js --clean  delete ~/claude-demo
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.join(os.homedir(), 'claude-demo');
const CLAUDE = path.join(ROOT, '.claude');
const CODE = path.join(ROOT, 'projects');

if (process.argv.includes('--clean')) {
  for (const f of fs.existsSync(path.join(CLAUDE, 'sessions')) ? fs.readdirSync(path.join(CLAUDE, 'sessions')) : []) {
    try { process.kill(Number(f.split('.')[0])); } catch { /* already gone */ }
  }
  fs.rmSync(ROOT, { recursive: true, force: true });
  console.log(`Removed ${ROOT}`);
  process.exit(0);
}

const now = Date.now();
const H = 3600000;
const D = 24 * H;
const uuid = () => crypto.randomUUID();

// [project, branch, title, startedAgo, steps]; a step is a prompt with Claude's reply, edits and commands.
const SESSIONS = [
  ['my-web-app', 'feature/dark-mode', 'dark-mode-toggle', 2 * H, [
    ['Add a dark mode toggle to the header', 'I\'ll add a ThemeToggle component and store the choice in localStorage.',
      ['src/components/ThemeToggle.tsx', 'src/components/Header.tsx', 'src/styles/theme.css'], [['npm test -- ThemeToggle', 'Run the toggle tests']]],
    ['Remember the choice when the page reloads', 'The toggle now reads the saved theme on startup and falls back to the system setting.',
      ['src/hooks/useTheme.ts'], [['npm test', 'Run all tests'], ['git add -A && git commit -m "feat: add dark mode toggle"', 'Commit the change']]],
  ]],
  ['api-server', 'fix/login-redirect', 'fix-login-redirect', 40 * 60000, [
    ['Users get sent to /undefined after logging in. Find out why', 'The redirect URL is read before the session is saved. I\'ll move it after the save.',
      ['src/routes/auth.ts'], [['npm run test:auth', 'Run the auth tests']]],
    ['Add a test for the redirect', 'Added a test that logs in and checks the redirect target.',
      ['test/auth.redirect.test.ts'], [['npm run test:auth', 'Run the auth tests']]],
  ]],
  ['docs-site', 'main', 'update-getting-started-guide', 26 * H, [
    ['Update the getting started guide for the new install command', 'Updated the install steps and the screenshots section.',
      ['docs/getting-started.md', 'docs/install.md'], [['npm run build', 'Build the docs site']]],
  ]],
  ['mobile-app', 'feature/offline-mode', 'offline-mode-caching', 28 * H, [
    ['Cache the last 50 articles so the app works offline', 'I\'ll add a small cache layer on top of the article service.',
      ['src/services/articleCache.ts', 'src/services/articles.ts'], [['npm test -- articleCache', 'Run the cache tests']]],
    ['Show a banner when the app is offline', 'Added an OfflineBanner component that listens to the network status.',
      ['src/components/OfflineBanner.tsx'], [['git commit -am "feat: offline banner"', 'Commit the change']]],
  ]],
  ['api-server', 'chore/upgrade-node', 'upgrade-to-node-22', 3 * D, [
    ['Upgrade the project to Node 22', 'Updated .nvmrc, the Dockerfile and the CI matrix.',
      ['.nvmrc', 'Dockerfile', '.github/workflows/ci.yml'], [['npm ci && npm test', 'Install and test on Node 22']]],
  ]],
  ['my-web-app', 'feature/settings-page', 'settings-page-redesign', 4 * D, [
    ['Redesign the settings page with tabs', 'Split the page into Profile, Notifications and Appearance tabs.',
      ['src/pages/Settings.tsx', 'src/components/Tabs.tsx'], [['npm run dev', 'Start the dev server']]],
    ['Move the ThemeToggle into the new Appearance tab', 'Moved it and kept the header shortcut.',
      ['src/pages/Settings.tsx'], []],
  ]],
  ['data-pipeline', 'main', 'nightly-report-job', 12 * D, [
    ['Write a job that emails a CSV report every night', 'Added a scheduled job that builds the CSV and sends it with the mail service.',
      ['jobs/nightlyReport.py', 'jobs/schedule.yaml'], [['pytest tests/test_nightly_report.py', 'Run the job tests']]],
  ]],
  ['docs-site', 'main', 'fix-broken-links', 40 * D, [
    ['Find and fix broken links in the docs', 'Fixed 7 broken links and added a link check to CI.',
      ['docs/api.md', 'docs/faq.md'], [['npx linkinator ./build', 'Check for broken links']]],
  ]],
];

const enc = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');
const ids = [];
for (const [project, branch, title, ago, steps] of SESSIONS) {
  const id = uuid();
  ids.push(id);
  const cwd = path.join(CODE, project);
  fs.mkdirSync(cwd, { recursive: true });
  const dir = path.join(CLAUDE, 'projects', enc(cwd));
  fs.mkdirSync(dir, { recursive: true });
  let t = now - ago;
  let parent = null;
  const lines = [];
  const rec = (o) => {
    const u = uuid();
    lines.push(JSON.stringify({ parentUuid: parent, isSidechain: false, ...o, uuid: u, timestamp: new Date(t).toISOString(), cwd, sessionId: id, gitBranch: branch }));
    parent = u;
    t += 90000;
  };
  for (const [prompt, reply, files, cmds] of steps) {
    rec({ type: 'user', message: { role: 'user', content: prompt } });
    const content = [{ type: 'text', text: reply }];
    for (const f of files) content.push({ type: 'tool_use', id: `toolu_${uuid().slice(0, 8)}`, name: 'Edit', input: { file_path: path.join(cwd, f), old_string: '', new_string: '' } });
    for (const [command, description] of cmds) content.push({ type: 'tool_use', id: `toolu_${uuid().slice(0, 8)}`, name: 'Bash', input: { command, description } });
    rec({ type: 'assistant', message: { role: 'assistant', content } });
    const results = content.filter((c) => c.type === 'tool_use').map((c) => ({ type: 'tool_result', tool_use_id: c.id, content: 'ok' }));
    if (results.length) rec({ type: 'user', message: { role: 'user', content: results } });
  }
  lines.push(JSON.stringify({ type: 'ai-title', aiTitle: title, sessionId: id }));
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  const mtime = new Date(t);
  fs.utimesSync(file, mtime, mtime);
}

// Two "running" sessions, backed by harmless sleep processes so they show as live.
const sessionsDir = path.join(CLAUDE, 'sessions');
fs.mkdirSync(sessionsDir, { recursive: true });
for (const [i, status, waitingFor] of [[1, 'waiting', 'permission to run npm run test:auth'], [0, 'busy', null]]) {
  const p = spawn('sleep', ['14400'], { detached: true, stdio: 'ignore' });
  p.unref();
  const cwd = path.join(CODE, SESSIONS[i][0]);
  fs.writeFileSync(path.join(sessionsDir, `${p.pid}.json`), JSON.stringify({ pid: p.pid, sessionId: ids[i], cwd, status, waitingFor, updatedAt: now }));
}

// Stand-in for `claude` in the demo window: the real Claude Code would show your account and organization
// on its start screen, so Resume and Fork only print what they would do.
// It is named `claude` and put first on the demo terminal's PATH, so the terminal shows a normal `claude --resume …`.
const binDir = path.join(ROOT, 'bin');
fs.mkdirSync(binDir, { recursive: true });
const fakeClaude = path.join(binDir, 'claude');
fs.writeFileSync(fakeClaude, `#!/bin/sh
echo
echo "  [demo] Claude Code would now continue this session:"
echo "         claude $*"
echo "         in $(basename "$PWD")"
echo
`, { mode: 0o755 });

const demoPath = `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`;

// Isolated VS Code: its own settings and extensions, so your normal setup is untouched.
const userDir = path.join(ROOT, 'vscode-user');
const extDir = path.join(ROOT, 'vscode-extensions');
fs.mkdirSync(path.join(userDir, 'User'), { recursive: true });
fs.writeFileSync(path.join(userDir, 'User', 'settings.json'), JSON.stringify({
  // Plain terminal without your shell config: the prompt shows only the folder, never the user or computer name.
  'terminal.integrated.profiles.osx': {
    demo: { path: '/bin/bash', args: ['--noprofile', '--norc'], env: { PS1: '\\W $ ', PATH: demoPath, BASH_SILENCE_DEPRECATION_WARNING: '1' } },
  },
  'terminal.integrated.defaultProfile.osx': 'demo',
  'terminal.integrated.profiles.linux': {
    demo: { path: '/bin/bash', args: ['--noprofile', '--norc'], env: { PS1: '\\W $ ', PATH: demoPath } },
  },
  // Keep the window clean: no chat panel, sign-in button or other AI features.
  'chat.disableAIFeatures': true,
  'workbench.secondarySideBar.defaultVisibility': 'hidden',
  'terminal.integrated.defaultProfile.linux': 'demo',
  'window.title': '${rootName}',
  'workbench.startupEditor': 'none',
  'workbench.tips.enabled': false,
  'security.workspace.trust.enabled': false,
  'window.zoomLevel': 1,
  'telemetry.telemetryLevel': 'off',
  'extensions.autoUpdate': false,
}, null, 2));

const repo = path.resolve(__dirname, '..');
const vsix = fs.readdirSync(repo).filter((f) => /^claude-terminal-sessions-.*\.vsix$/.test(f)).sort().pop();
if (!vsix) { console.error('Build the extension first: npm run package'); process.exit(1); }
const env = { ...process.env, CLAUDE_CONFIG_DIR: CLAUDE };
execFileSync('code', ['--user-data-dir', userDir, '--extensions-dir', extDir, '--install-extension', path.join(repo, vsix), '--force'], { env, stdio: 'ignore' });
spawn('code', ['--user-data-dir', userDir, '--extensions-dir', extDir, '--new-window', path.join(CODE, 'my-web-app')], { env, detached: true, stdio: 'ignore' }).unref();

console.log(`Created ${SESSIONS.length} demo sessions in ${CLAUDE}
Opened a separate VS Code window (installed ${vsix}). Click the Claude Terminal Sessions icon in its activity bar.
When you are done: node scripts/demo.js --clean`);
