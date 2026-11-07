// Full-text search inside a session's readable conversation (the Markdown built by parseDetails).
// Pure (no vscode dependency). Line numbers match the opened conversation document.

// Classify each line of the conversation Markdown: prompt, reply, command, file or tool.
function* classifiedLines(markdown) {
  const lines = String(markdown || '').split('\n');
  let mode = 'header';
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^## 👤 Prompt \d+/.test(l)) { mode = 'prompt'; continue; }
    if (l === '**🤖 Claude:**') { mode = 'reply'; continue; }
    if (l.startsWith('- 💻 ')) { yield { line: i, kind: 'command', text: l.slice(5) }; continue; }
    if (l.startsWith('- ✏️ ')) { yield { line: i, kind: 'file', text: l.slice(l.indexOf(' ') + 1) }; continue; }
    if (l.startsWith('- 🔧 ')) { yield { line: i, kind: 'tool', text: l.slice(5) }; continue; }
    if (mode === 'header' || l === '---' || !l.trim()) continue;
    yield { line: i, kind: mode, text: l };
  }
}

function snippet(text, idx, len, width = 110) {
  const t = text.replace(/\s+/g, ' ');
  if (t.length <= width) return t.trim();
  const start = Math.max(0, Math.min(idx - Math.floor((width - len) / 2), t.length - width));
  return `${start > 0 ? '…' : ''}${t.slice(start, start + width).trim()}${start + width < t.length ? '…' : ''}`;
}

// Matches of `query` (case-insensitive; every word must appear on the line) in one conversation.
function searchConversation(markdown, query, { limit = 50, kinds } = {}) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return { matches: [], total: 0 };
  const matches = [];
  let total = 0;
  for (const l of classifiedLines(markdown)) {
    if (kinds && !kinds.includes(l.kind)) continue;
    const low = l.text.toLowerCase();
    if (!words.every((w) => low.includes(w))) continue;
    total++;
    if (matches.length < limit) {
      const idx = low.replace(/\s+/g, ' ').indexOf(words[0]);
      matches.push({ line: l.line, kind: l.kind, snippet: snippet(l.text, Math.max(0, idx), words[0].length) });
    }
  }
  return { matches, total };
}

module.exports = { searchConversation, classifiedLines };
