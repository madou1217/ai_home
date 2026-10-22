// P5 官方价格源：只在宿主的价格同步周期里抓取官方机器可读页面，不在请求路径上联网。
// 失败时回退到内置离线快照，并标记 stale，避免把旧价格当成新鲜事实。
import { definePlugin } from '@ai-home/plugin-sdk';

const SOURCE_ID = 'official:openai';
const SOURCE_URL = 'https://developers.openai.com/api/docs/pricing.md';
const SNAPSHOT_FETCHED_AT = '2026-10-20T00:00:00.000Z';
const FETCH_TIMEOUT_MS = 10_000;

const SOURCE = {
  id: SOURCE_ID,
  kind: 'official',
  authority: 90,
  confidence: 0.9,
  url: SOURCE_URL
};

// 离线快照：网络不可达、页面改版或解析不到任何报价时使用。
const SNAPSHOT = [
  { provider: 'openai', model: 'gpt-5.4', input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: null, cacheWrite1h: null, reasoning: null },
  { provider: 'openai', model: 'gpt-5.4-mini', input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: null, cacheWrite1h: null, reasoning: null },
  { provider: 'openai', model: 'gpt-5.3-codex', input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: null, cacheWrite1h: null, reasoning: null }
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

function modelId(cell) {
  // “gpt-5.5 (<272K context length)”里的括号是上下文说明，不是模型 id 的一部分。
  return String(cell || '').replace(/<[^>]*>/g, '').replace(/\s*\([^)]*\)\s*/g, '').trim();
}

/**
 * OpenAI 的 .md 页面把“Standard pricing data”渲染成 Markdown 表格。
 * 只取 Batch 之前的标准价表；Batch / Priority 不混进同一份目录。
 */
function parseOpenAiPricing(markdown) {
  const text = String(markdown || '');
  const standard = text.split(/^###\s+Batch pricing data\s*$/m)[0];
  const quotes = [];
  const seen = new Set();
  for (const line of standard.split('\n')) {
    const cells = markdownCells(line);
    if (!cells || cells.length < 5) continue;
    const model = modelId(cells[0]);
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(model)) continue;
    const input = numberValue(cells[1]);
    const output = numberValue(cells[4]);
    if (input === null || output === null) continue;
    if (seen.has(model)) continue;
    seen.add(model);
    quotes.push({
      provider: 'openai',
      model,
      input,
      output,
      cacheRead: numberValue(cells[2]),
      cacheWrite: numberValue(cells[3]),
      cacheWrite1h: null,
      reasoning: null
    });
  }
  return quotes;
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
    const quotes = parseOpenAiPricing(await response.text());
    if (!quotes.length) throw new Error('no_quotes');
    return {
      quotes: withSource(quotes, new Date().toISOString(), false),
      source: { ...SOURCE, fetchedAt: new Date().toISOString() }
    };
  } catch (_error) {
    return {
      quotes: withSource(SNAPSHOT, SNAPSHOT_FETCHED_AT, true),
      source: { ...SOURCE, fetchedAt: SNAPSHOT_FETCHED_AT, stale: true }
    };
  }
}

export { loadQuotes, parseOpenAiPricing, SNAPSHOT };

export default definePlugin({
  name: 'aih.pricing.official.openai',
  apply(ctx) {
    ctx.aih.register('aih.pricing.official.openai.catalog', async () => {
      const loaded = await loadQuotes();
      return {
        generatedAt: loaded.source.fetchedAt,
        source: loaded.source,
        quotes: loaded.quotes
      };
    });
  }
});
