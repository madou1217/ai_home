// P5 官方价格源：只在宿主的价格同步周期里抓取官方机器可读页面，不在请求路径上联网。
// 失败时回退到内置离线快照，并标记 stale，避免把旧价格当成新鲜事实。
import { definePlugin } from '@ai-home/plugin-sdk';

const SOURCE_ID = 'official:anthropic';
const SOURCE_URL = 'https://platform.claude.com/docs/en/about-claude/pricing.md';
const SNAPSHOT_FETCHED_AT = '2026-10-20T00:00:00.000Z';
const FETCH_TIMEOUT_MS = 10_000;

const SOURCE = {
  id: SOURCE_ID,
  kind: 'official',
  authority: 90,
  confidence: 0.9,
  url: SOURCE_URL
};

const SNAPSHOT = [
  { provider: 'anthropic', model: 'claude-opus-4-6', input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10, reasoning: null },
  { provider: 'anthropic', model: 'claude-sonnet-4-6', input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6, reasoning: null },
  { provider: 'anthropic', model: 'claude-haiku-4-5', input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25, cacheWrite1h: 2, reasoning: null }
];

function numberValue(value) {
  const match = String(value === undefined || value === null ? '' : value).match(/\$?\s*([0-9]+(?:\.[0-9]+)?)/);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function markdownCells(line) {
  const text = String(line || '').trim();
  if (!text.startsWith('|') || !text.endsWith('|')) return null;
  return text.slice(1, -1).split('|').map((cell) => cell.trim());
}

function cleanModelLabel(cell) {
  return String(cell || '')
    .replace(/<[^>]*>/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .trim();
}

function modelId(cell) {
  return cleanModelLabel(cell)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function tierThreshold(cell) {
  const match = String(cell || '').match(/for prompts over\s+([0-9][0-9,]*)\s+tokens/i);
  if (!match) return null;
  const value = Number(match[1].replace(/,/g, ''));
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Anthropic 的 .md 页面用 Markdown 表格列标准价：
 * Model | Base input | 5m cache writes | 1h cache writes | Cache hits | Output。
 * 1h cache write 必须独立读取，绝不从 5m 复制。
 */
function parseAnthropicPricing(markdown) {
  const text = String(markdown || '');
  const quotes = new Map();
  for (const line of text.split('\n')) {
    const cells = markdownCells(line);
    if (!cells || cells.length < 6) continue;
    const model = modelId(cells[0]);
    if (!/^claude-[a-z0-9-]+$/.test(model)) continue;
    const input = numberValue(cells[1]);
    const cacheWrite = numberValue(cells[2]);
    const cacheWrite1h = numberValue(cells[3]);
    const cacheRead = numberValue(cells[4]);
    const output = numberValue(cells[5]);
    if (input === null || output === null) continue;
    const dimensions = { input, output, cacheRead, cacheWrite, cacheWrite1h, reasoning: null };
    const threshold = tierThreshold(cells[0]);
    if (threshold !== null) {
      const existing = quotes.get(model);
      if (!existing) {
        quotes.set(model, {
          provider: 'anthropic',
          model,
          input: null,
          output: null,
          cacheRead: null,
          cacheWrite: null,
          cacheWrite1h: null,
          reasoning: null,
          tiers: [{ when: { contextTokensGt: threshold }, ...dimensions }]
        });
      } else {
        existing.tiers = [...(existing.tiers || []), { when: { contextTokensGt: threshold }, ...dimensions }];
      }
      continue;
    }
    if (quotes.has(model)) continue;
    quotes.set(model, { provider: 'anthropic', model, ...dimensions });
  }
  return Array.from(quotes.values());
}

function withSource(quotes, fetchedAt, stale) {
  const source = { ...SOURCE, fetchedAt, ...(stale ? { stale: true } : {}) };
  return quotes.map((quote) => ({ ...quote, source }));
}

async function loadQuotes() {
  try {
    const response = await fetch(SOURCE_URL, {
      headers: {
        accept: 'text/markdown,text/plain;q=0.9,*/*;q=0.1',
        'accept-language': 'en-US,en;q=0.9',
        'user-agent': 'aih-pricing-sync/1.0'
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    if (!response.ok) throw new Error(`http_${response.status}`);
    const quotes = parseAnthropicPricing(await response.text());
    if (!quotes.length) throw new Error('no_quotes');
    const fetchedAt = new Date().toISOString();
    return { quotes: withSource(quotes, fetchedAt, false), source: { ...SOURCE, fetchedAt } };
  } catch (_error) {
    return {
      quotes: withSource(SNAPSHOT, SNAPSHOT_FETCHED_AT, true),
      source: { ...SOURCE, fetchedAt: SNAPSHOT_FETCHED_AT, stale: true }
    };
  }
}

export { loadQuotes, parseAnthropicPricing, SNAPSHOT };

export default definePlugin({
  name: 'aih.pricing.official.anthropic',
  apply(ctx) {
    ctx.aih.register('aih.pricing.official.anthropic.catalog', async () => {
      const loaded = await loadQuotes();
      return {
        generatedAt: loaded.source.fetchedAt,
        source: loaded.source,
        quotes: loaded.quotes
      };
    });
  }
});
