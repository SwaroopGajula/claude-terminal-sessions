// Command lines for the user's terminal shell (PowerShell, cmd, bash/zsh, fish). Pure (no vscode dependency).

// Which syntax to use, from VS Code's default terminal shell path (vscode.env.shell) and the OS.
function shellKind(platform, shellPath) {
  const s = String(shellPath || '').toLowerCase().replace(/\.exe$/, '');
  const name = s.split(/[\\/]/).pop();
  if (name === 'pwsh' || name === 'powershell') return 'powershell';
  if (name === 'cmd') return 'cmd';
  if (name === 'fish') return 'fish';
  if (name) return 'posix'; // bash, zsh, sh, Git Bash, WSL
  return platform === 'win32' ? 'powershell' : 'posix';
}

function quote(kind, value) {
  const s = String(value);
  if (kind === 'powershell') return `'${s.replace(/'/g, "''")}'`;
  if (kind === 'cmd') return `"${s.replace(/"/g, '""')}"`;
  if (kind === 'fish') return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// "Go to this folder, then run this", in the shell's own syntax. `command` is inserted as-is.
function cdAndRun(kind, cwd, command) {
  if (kind === 'powershell') return `Set-Location -LiteralPath ${quote(kind, cwd)}; ${command}`;
  if (kind === 'cmd') return `cd /d ${quote(kind, cwd)} && ${command}`;
  return `cd ${quote(kind, cwd)} && ${command}`; // posix shells and fish 3+
}

module.exports = { shellKind, quote, cdAndRun };
