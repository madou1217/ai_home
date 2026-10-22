// P5 官方价格源：只在宿主的价格同步周期里抓取官方机器可读页面，不在请求路径上联网。
// 失败时回退到内置离线快照，并标记 stale，避免把旧价格当成新鲜事实。
import { definePlugin } from '@ai-home/plugin-sdk';

const SOURCE_ID = 'official:deepseek';
const SOURCE_URL = 'https://api-docs.deepseek.com/quick_start/pricing';
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
  { provider: 'deepseek', model: 'deepseek-v4-pro', input: 0.66, output: 1.98, cacheRead: 0.022, cacheWrite: null, cacheWrite1h: null, reasoning: null },
  { provider: 'deepseek', model: 'deepseek-v4-flash', input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: null, cacheWrite1h: null, reasoning: null }
];

function numberValue(value) {
  const match = String(value === undefined || value === null ? '' : value).match(/\$?\s*([0-9]+(?:\.[0-9]+)?)/);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function decodeEntities(text) {
  return String(text || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_match, dec) => String.fromCodePoint(Number(dec)))
    .replace(/\s+/g, ' ')
    .trim();
}

function tableRows(tableHtml) {
  const rows = [];
  const rowPattern = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  while ((rowMatch = rowPattern.exec(tableHtml))) {
    const cells = [];
    const cellPattern = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let cellMatch;
    while ((cellMatch = cellPattern.exec(rowMatch[1]))) {
      cells.push(decodeEntities(cellMatch[1]));
    }
    if (cells.length) rows.push(cells);
  }
  return rows;
}

function modelName(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, '')
    .replace(/\([0-9]+\)\s*$/g, '')
    .trim();
}

/**
 * DeepSeek 的单表把每个模型放在独立列，价格分成 CACHE HIT / CACHE MISS / OUTPUT，
 * 每项又有 OFF-PEAK / PEAK 两行。计费目录统一采用 OFF-PEAK（折扣价）。
 */
function parseDeepSeekPricing(html) {
  const text = String(html || '');
  const tableMatch = text.match(/<table\b[^>]*>([\s\S]*?)<\/table>/i);
  if (!tableMatch) return [];
  const rows = tableRows(tableMatch[1]);
  const header = rows.find((row) => String(row[0] || '').toUpperCase().startsWith('MODEL'));
  if (!header || header.length < 2) return [];
  const models = header.slice(1).map(modelName).filter(Boolean);
  if (!models.length) return [];

  const prices = models.map(() => ({ input: null, output: null, cacheRead: null }));
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const label = row.map((cell) => String(cell || '').toUpperCase()).join(' ');
    if (!/CACHE HIT|CACHE MISS|OUTPUT TOKENS/.test(label)) continue;
    // 找到同一组里的 OFF-PEAK 行：它可能在当前行，也可能是下一行。
    const offPeak = row.some((cell) => /^OFF-PEAK$/i.test(String(cell).trim()))
      ? row
      : (rows[index + 1] && rows[index + 1].some((cell) => /^OFF-PEAK$/i.test(String(cell).trim())) ? rows[index + 1] : null);
    if (!offPeak) continue;
    const values = offPeak.slice(-models.length).map(numberValue);
    if (values.length !== models.length) continue;
    let dimension = null;
    if (/CACHE HIT/.test(label)) dimension = 'cacheRead';
    else if (/CACHE MISS/.test(label)) dimension = 'input';
    else if (/OUTPUT TOKENS/.test(label)) dimension = 'output';
    if (!dimension) continue;
    values.forEach((value, modelIndex) => {
      if (value !== null) prices[modelIndex][dimension] = value;
    });
  }

  const quotes = [];
  const aliases = { 'deepseek-flash': ['deepseek-v4-flash'] };
  models.forEach((model, index) => {
    const price = prices[index];
    if (price.input === null || price.output === null) return;
    for (const name of [model, ...(aliases[model] || [])]) {
      quotes.push({
        provider: 'deepseek',
        model: name,
        input: price.input,
        output: price.output,
        cacheRead: price.cacheRead,
        cacheWrite: null,
        cacheWrite1h: null,
        reasoning: null
      });
    }
  });
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
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'en-US,en;q=0.9',
        'user-agent': 'aih-pricing-sync/1.0'
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    if (!response.ok) throw new Error(`http_${response.status}`);
    const quotes = parseDeepSeekPricing(await response.text());
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

export { loadQuotes, parseDeepSeekPricing, SNAPSHOT };

export default definePlugin({
  name: 'aih.pricing.official.deepseek',
  apply(ctx) {
    ctx.aih.register('aih.pricing.official.deepseek.catalog', async () => {
      const loaded = await loadQuotes();
      return {
        generatedAt: loaded.source.fetchedAt,
        source: loaded.source,
        quotes: loaded.quotes
      };
    });
  }
});
