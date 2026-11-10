// Token usage and estimated cost from Claude Code transcripts. Pure (no vscode dependency).
//
// Each assistant record carries message.usage. Claude Code writes one record per content block, so the
// same message (same message.id + requestId) appears several times with identical usage: count it once.
// Tokens are stored per day and model; cost is computed when displayed, so pricing changes apply at once.

// $ per million tokens (Anthropic API list prices, from the model table cached 2026-10-06).
// Cache writes: 1.25x input (5-minute TTL), 2x input (1-hour TTL). Cache reads vary by model.
const p = (input, output, cacheRead) => ({ input, output, cacheRead, cacheWrite5m: input * 1.25, cacheWrite1h: input * 2 });
const PRICES = {
  'claude-fable-5-1': p(10, 50, 0.25),
  'claude-mythos-5-1': p(10, 50, 0.25),
  'claude-fable-5': p(10, 50, 1),
  'claude-mythos-5': p(10, 50, 1),
  'claude-opus-5-5': p(4, 20, 0.2),
  'claude-opus-5': p(5, 25, 0.5),
  'claude-opus-4-8': p(5, 25, 0.5),
  'claude-opus-4-7': p(5, 25, 0.5),
  'claude-opus-4-6': p(5, 25, 0.5),
  'claude-sonnet-5-5': p(2, 10, 0.2),
  'claude-sonnet-5': p(2, 10, 0.2),
  'claude-sonnet-4-6': p(3, 15, 0.3),
  'claude-haiku-5-5': p(0.1, 0.5, 0.01), // prompts up to 100K tokens; longer prompts cost more
  'claude-haiku-4-5': p(1, 5, 0.1),
};
const FAST_MULTIPLIER = 2; // fast mode is billed at 2x standard rates
const KINDS = ['input', 'output', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h'];

const empty = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, requests: 0 });

function pad(n) { return String(n).padStart(2, '0'); }
function dayKey(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

// Usage collector for one session (main transcript plus subagent transcripts).
function createCollector() {
  const seen = new Set();
  const days = {}; // { 'YYYY-MM-DD': { model: tokens } }
  return {
    days,
    add(o) {
      const m = o && o.message;
      const u = m && m.usage;
      if (!u || !m.model || m.model === '<synthetic>') return;
      if (m.id) {
        const key = `${m.id}|${o.requestId || ''}`;
        if (seen.has(key)) return;
        seen.add(key);
      }
      const t = o.timestamp ? new Date(o.timestamp) : null;
      const day = t && !isNaN(t) ? dayKey(t) : 'unknown';
      const model = u.speed === 'fast' ? `${m.model}:fast` : m.model;
      const cc = u.cache_creation;
      const row = ((days[day] = days[day] || {})[model] = days[day][model] || empty());
      row.input += u.input_tokens || 0;
      row.output += u.output_tokens || 0;
      row.cacheRead += u.cache_read_input_tokens || 0;
      // Older records only have the total; treat it as 5-minute writes.
      row.cacheWrite5m += cc ? cc.ephemeral_5m_input_tokens || 0 : u.cache_creation_input_tokens || 0;
      row.cacheWrite1h += cc ? cc.ephemeral_1h_input_tokens || 0 : 0;
      row.requests += 1;
    },
  };
}

// Price for a model id, honoring user overrides; null when unknown.
function priceFor(model, overrides = {}) {
  const fast = model.endsWith(':fast');
  const base = fast ? model.slice(0, -5) : model;
  const candidates = [base, base.replace(/-\d{8}$/, ''), base.replace(/^(anthropic\.|us\.anthropic\.|eu\.anthropic\.)/, '').replace(/[-@]\d{8}.*$/, '')];
  let price = null;
  for (const c of candidates) {
    if (overrides[c]) { price = { ...(PRICES[c] || {}), ...overrides[c] }; break; }
    if (PRICES[c]) { price = PRICES[c]; break; }
  }
  if (!price || KINDS.some((k) => typeof price[k] !== 'number')) return null;
  if (!fast) return price;
  const out = {};
  for (const k of KINDS) out[k] = price[k] * FAST_MULTIPLIER;
  return out;
}

function costOf(tokens, price) {
  return KINDS.reduce((sum, k) => sum + (tokens[k] || 0) * price[k], 0) / 1e6;
}

// Totals for a set of sessions' usage (each a `days` map) within [fromKey, toKey] (inclusive day keys; omit for all).
function summarize(usages, { fromKey, toKey, overrides } = {}) {
  const total = { ...empty(), cost: 0 };
  const byModel = {};
  const unpriced = new Set();
  for (const days of usages) {
    for (const [day, models] of Object.entries(days || {})) {
      if ((fromKey && day < fromKey) || (toKey && day > toKey)) continue;
      for (const [model, t] of Object.entries(models)) {
        const price = priceFor(model, overrides);
        const cost = price ? costOf(t, price) : 0;
        if (!price) unpriced.add(model.replace(/:fast$/, ''));
        const name = model.replace(/:fast$/, '');
        const bm = (byModel[name] = byModel[name] || { ...empty(), cost: 0 });
        for (const k of [...KINDS, 'requests']) { bm[k] += t[k]; total[k] += t[k]; }
        bm.cost += cost;
        total.cost += cost;
      }
    }
  }
  return { ...total, byModel, unpriced: [...unpriced] };
}

function formatTokens(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}K`;
  return String(n);
}

function formatCost(c) {
  if (!c) return '$0';
  if (c < 0.01) return '<$0.01';
  if (c < 100) return `$${c.toFixed(2)}`;
  return `$${Math.round(c).toLocaleString('en-US')}`;
}

// Markdown report. entries: [{ title, cwd, usage }]; range: { label, fromKey, toKey, overrides }.
function buildReport(entries, { label = 'All time', fromKey, toKey, overrides } = {}) {
  const sum = (list, extra = {}) => summarize(list.map((e) => e.usage), { fromKey, toKey, overrides, ...extra });
  const total = sum(entries);
  const T = formatTokens;
  const C = formatCost;
  const L = [];
  const span = fromKey ? (fromKey === toKey ? ` (${fromKey})` : ` (${fromKey} to ${toKey})`) : '';
  L.push(`# Claude Code usage: ${label}${span}`, '');
  L.push('_Estimated at Anthropic API list prices. On a Pro or Max plan you pay the subscription instead, so read this as what the same work would cost through the API._', '');
  if (!total.requests) { L.push('_No Claude Code usage in this period._'); return L.join('\n') + '\n'; }
  L.push(`**≈ ${C(total.cost)}** · ${T(total.output)} output · ${T(total.input + total.cacheWrite5m + total.cacheWrite1h)} input · ${T(total.cacheRead)} cache reads · ${total.requests.toLocaleString('en-US')} requests`);
  if (total.unpriced.length) L.push('', `_No price known for ${total.unpriced.map((m) => `\`${m}\``).join(', ')}; their tokens are counted but not priced. Add them with the \`claudeSessions.modelPricing\` setting._`);

  const days = new Set();
  for (const e of entries) for (const d of Object.keys(e.usage || {})) if (d !== 'unknown' && (!fromKey || d >= fromKey) && (!toKey || d <= toKey)) days.add(d);
  if (days.size > 1) {
    L.push('', '## By day', '', '| Day | Cost | Output | Requests |', '|---|---:|---:|---:|');
    for (const d of [...days].sort().reverse()) {
      const u = sum(entries, { fromKey: d, toKey: d });
      L.push(`| ${d} | ${C(u.cost)} | ${T(u.output)} | ${u.requests} |`);
    }
  }

  L.push('', '## By model', '', '| Model | Cost | New input | Cache writes | Cache reads | Output | Requests |', '|---|---:|---:|---:|---:|---:|---:|');
  for (const [m, u] of Object.entries(total.byModel).sort((a, b) => b[1].cost - a[1].cost)) {
    L.push(`| \`${m}\` | ${total.unpriced.includes(m) ? 'n/a' : C(u.cost)} | ${T(u.input)} | ${T(u.cacheWrite5m + u.cacheWrite1h)} | ${T(u.cacheRead)} | ${T(u.output)} | ${u.requests} |`);
  }

  const per = entries.map((e) => ({ e, u: sum([e]) })).filter((x) => x.u.requests);
  const byProject = new Map();
  for (const x of per) {
    const k = x.e.cwd || '(unknown)';
    const g = byProject.get(k) || { cost: 0, output: 0, sessions: 0 };
    g.cost += x.u.cost; g.output += x.u.output; g.sessions += 1;
    byProject.set(k, g);
  }
  L.push('', '## By project', '', '| Project | Cost | Sessions | Output |', '|---|---:|---:|---:|');
  for (const [k, g] of [...byProject].sort((a, b) => b[1].cost - a[1].cost)) {
    L.push(`| ${k.split(/[\\/]/).filter(Boolean).pop() || k} | ${C(g.cost)} | ${g.sessions} | ${T(g.output)} |`);
  }

  L.push('', '## Most expensive sessions', '', '| Session | Project | Cost | Output | Requests |', '|---|---|---:|---:|---:|');
  for (const x of per.sort((a, b) => b.u.cost - a.u.cost).slice(0, 15)) {
    const title = String(x.e.title || '').replace(/\|/g, '/').slice(0, 70);
    L.push(`| ${title} | ${(x.e.cwd || '').split(/[\\/]/).filter(Boolean).pop() || ''} | ${C(x.u.cost)} | ${T(x.u.output)} | ${x.u.requests} |`);
  }
  return L.join('\n') + '\n';
}

module.exports = { buildReport, PRICES, createCollector, priceFor, costOf, summarize, formatTokens, formatCost, dayKey };
