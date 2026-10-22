// P5 官方价格源：只在宿主的价格同步周期里抓取官方机器可读页面，不在请求路径上联网。
// 失败时回退到内置离线快照，并标记 stale，避免把旧价格当成新鲜事实。
import { definePlugin } from '@ai-home/plugin-sdk';

const SOURCE_ID = 'official:google';
const SOURCE_URL = 'https://ai.google.dev/gemini-api/docs/pricing?hl=en';
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
  { provider: 'google', model: 'gemini-3.1-pro-preview', input: 2, output: 12, cacheRead: 0.2, cacheWrite: null, cacheWrite1h: null, reasoning: null },
  { provider: 'google', model: 'gemini-3.5-flash', input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: null, cacheWrite1h: null, reasoning: null },
  { provider: 'google', model: 'gemini-3.8-flash', input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: null, cacheWrite1h: null, reasoning: null }
];

const NON_TOKEN_MODEL = /(?:^|-)(live|tts|image|embedding|robotics|transcribe|translate|native-audio)(?:-|$)/i;

function decodeEntities(text) {
  return String(text || '')
    .replace(/<br\s*\/?>/gi, '\n')
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

function priceSegments(text) {
  return decodeEntities(text)
    .split(/\s+(?=\$\s*[0-9]|Free of charge|Not available)/i)
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Google 页面会同时给出“当前价 through <date>”和“未来价 starting <date>”。
 * 按当前时间选适用段；没有日期或日期无法解析时退回第一段。
 */
function paidPrice(text, now = Date.now()) {
  const segments = priceSegments(text);
  if (!segments.length) return null;
  const candidates = [];
  for (const segment of segments) {
    const free = /^free of charge/i.test(segment);
    const unavailable = /^not available/i.test(segment);
    if (unavailable) continue;
    if (free) {
      candidates.push({ value: 0, from: 0, until: Number.POSITIVE_INFINITY });
      continue;
    }
    const match = segment.match(/\$\s*([0-9]+(?:\.[0-9]+)?)/);
    if (!match) continue;
    const value = Number(match[1]);
    if (!Number.isFinite(value)) continue;
    const untilMatch = segment.match(/through\s+([A-Z][a-z]+\s+[0-9]{1,2},\s+[0-9]{4})/i);
    const fromMatch = segment.match(/starting\s+([A-Z][a-z]+\s+[0-9]{1,2},\s+[0-9]{4})/i);
    const until = untilMatch ? Date.parse(`${untilMatch[1]} 23:59:59 UTC`) : Number.POSITIVE_INFINITY;
    const from = fromMatch ? Date.parse(`${fromMatch[1]} 00:00:00 UTC`) : 0;
    candidates.push({
      value,
      from: Number.isFinite(from) ? from : 0,
      until: Number.isFinite(until) ? until : Number.POSITIVE_INFINITY
    });
  }
  const current = candidates.find((entry) => now >= entry.from && now <= entry.until);
  if (current) return current.value;
  return candidates.length ? candidates[0].value : null;
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
      cells.push(decodeEntities(cellMatch[1]).replace(/\s+/g, ' ').trim());
    }
    if (cells.length >= 2) rows.push(cells);
  }
  return rows;
}

function parseModelSection(model, sectionHtml, now) {
  const tableMatch = sectionHtml.match(/<table\b[^>]*class="[^"]*pricing-table[^"]*"[^>]*>([\s\S]*?)<\/table>/i);
  if (!tableMatch) return null;
  const rows = tableRows(tableMatch[1]);
  let input = null;
  let output = null;
  let cacheRead = null;
  for (const cells of rows) {
    const label = String(cells[0] || '').toLowerCase();
    const paid = cells[cells.length - 1];
    if (/^input price/.test(label)) input = paidPrice(paid, now);
    else if (/^output price/.test(label)) output = paidPrice(paid, now);
    else if (/^context caching price/.test(label)) cacheRead = paidPrice(paid, now);
  }
  if (input === null || output === null) return null;
  return {
    provider: 'google',
    model,
    input,
    output,
    cacheRead,
    cacheWrite: null,
    cacheWrite1h: null,
    reasoning: null
  };
}

function parseGooglePricing(html, now = Date.now()) {
  const text = String(html || '');
  const headings = Array.from(text.matchAll(/<h2\b[^>]*id="([^"]+)"[^>]*>[\s\S]*?<\/h2>/gi));
  const quotes = [];
  for (let index = 0; index < headings.length; index += 1) {
    const model = headings[index][1];
    if (!/^gemini-/.test(model) || NON_TOKEN_MODEL.test(model)) continue;
    const start = headings[index].index + headings[index][0].length;
    const end = index + 1 < headings.length ? headings[index + 1].index : text.length;
    const quote = parseModelSection(model, text.slice(start, end), now);
    if (quote) quotes.push(quote);
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
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'en-US,en;q=0.9',
        'user-agent': 'aih-pricing-sync/1.0'
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    if (!response.ok) throw new Error(`http_${response.status}`);
    const quotes = parseGooglePricing(await response.text());
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

export { loadQuotes, parseGooglePricing, SNAPSHOT };

export default definePlugin({
  name: 'aih.pricing.official.google',
  apply(ctx) {
    ctx.aih.register('aih.pricing.official.google.catalog', async () => {
      const loaded = await loadQuotes();
      return {
        generatedAt: loaded.source.fetchedAt,
        source: loaded.source,
        quotes: loaded.quotes
      };
    });
  }
});
