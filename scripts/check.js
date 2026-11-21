// Syntax check of every extension source file (npm run lint). Works on Windows too (no shell globbing).
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const files = fs.readdirSync(root).filter((f) => f.endsWith('.js'));
for (const f of files) execFileSync(process.execPath, ['--check', path.join(root, f)], { stdio: 'inherit' });
console.log(`Syntax OK: ${files.length} files`);
