// Where Claude Code keeps its data: $CLAUDE_CONFIG_DIR if set (Claude Code's own setting), else ~/.claude.
const path = require('path');
const os = require('os');

function claudeDir(env = process.env) {
  const v = (env.CLAUDE_CONFIG_DIR || '').trim();
  if (!v) return path.join(os.homedir(), '.claude');
  return path.resolve(v === '~' ? os.homedir() : v.startsWith('~/') ? path.join(os.homedir(), v.slice(2)) : v);
}

const CLAUDE_DIR = claudeDir();

module.exports = { claudeDir, CLAUDE_DIR };
