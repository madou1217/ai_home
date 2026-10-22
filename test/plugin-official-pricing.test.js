'use strict';

// P5 官方价格插件：解析器 + 失败回退。联网只由 catalog-sync 的周期任务触发；
// 这里用离线 HTML/Markdown 片段锁住页面形状，避免测试依赖外网。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const repoRoot = path.resolve(__dirname, '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-official-pricing-'));
test.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

function loadPlugin(name) {
  const dir = path.join(tempRoot, name);
  fs.mkdirSync(path.join(dir, 'node_modules', '@ai-home'), { recursive: true });
  fs.copyFileSync(
    path.join(repoRoot, 'examples', 'plugins', name, 'index.mjs'),
    path.join(dir, 'index.mjs')
  );
  const sdkLink = path.join(dir, 'node_modules', '@ai-home', 'plugin-sdk');
  fs.symlinkSync(path.join(repoRoot, 'lib', 'plugins', 'sdk'), sdkLink, 'dir');
  return import(pathToFileURL(path.join(dir, 'index.mjs')).href);
}

const pluginsPromise = Promise.all([
  loadPlugin('pricing-official-openai'),
  loadPlugin('pricing-official-anthropic'),
  loadPlugin('pricing-official-google'),
  loadPlugin('pricing-official-deepseek')
]);

const OPENAI_MARKDOWN = `
### Standard pricing data
| Model | Short context input | Short context cached input | Short context cache writes | Short context output |
| --- | --- | --- | --- | --- |
| gpt-5.5 (<272K context length) | $5.00 | $0.50 | - | $30.00 |
| gpt-5.4-mini | $0.75 | $0.075 | $0.10 | $4.50 |

### Batch pricing data
| Model | Short context input | Short context cached input | Short context cache writes | Short context output |
| --- | --- | --- | --- | --- |
| gpt-5.5 | $2.50 | $0.25 | - | $15.00 |
`;

const ANTHROPIC_MARKDOWN = `
| Model | Base input tokens | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Claude Opus 5.5 | $4 / MTok | $5 / MTok | $8 / MTok | $0.20 / MTok | $20 / MTok |
| Claude Haiku 5.5 (for prompts up to 100,000 tokens) | $0.10 / MTok | $0.125 / MTok | $0.20 / MTok | $0.01 / MTok | $0.50 / MTok |
| Claude Haiku 5.5 (for prompts over 100,000 tokens) | $0.50 / MTok | $0.625 / MTok | $1 / MTok | $0.05 / MTok | $2.50 / MTok |
`;

const GOOGLE_HTML = `
<h2 id="gemini-3.8-flash">Gemini 3.8 Flash</h2>
<table class="pricing-table"><tbody>
<tr><td>Input price</td><td>Free of charge</td><td>$0.75 through December 31, 2026.<br>$1.50 starting January 1, 2027.</td></tr>
<tr><td>Output price (including thinking tokens)</td><td>Free of charge</td><td>$3.75 through December 31, 2026.<br>$7.50 starting January 1, 2027.</td></tr>
<tr><td>Context caching price</td><td>Free of charge</td><td>$0.075 through December 31, 2026.<br>$0.15 starting January 1, 2027.</td></tr>
</tbody></table>
<h2 id="gemini-3.1-flash-image">Gemini 3.1 Flash Image</h2>
<table class="pricing-table"><tbody>
<tr><td>Input price</td><td>Not available</td><td>$0.30 per image</td></tr>
<tr><td>Output price</td><td>Not available</td><td>$0.30 per image</td></tr>
</tbody></table>
`;

const DEEPSEEK_HTML = `
<table><tbody>
<tr><td colspan="3">MODEL</td><td>deepseek-flash<sup>(1)</sup></td><td>deepseek-v4-pro</td></tr>
<tr><td rowspan="6">PRICING</td><td rowspan="2">1M INPUT TOKENS<br>(CACHE HIT)</td><td>OFF-PEAK</td><td>$0.003</td><td>$0.022</td></tr>
<tr><td>PEAK</td><td>$0.006</td><td>$0.044</td></tr>
<tr><td rowspan="2">1M INPUT TOKENS<br>(CACHE MISS)</td><td>OFF-PEAK</td><td>$0.15</td><td>$0.66</td></tr>
<tr><td>PEAK</td><td>$0.3</td><td>$1.32</td></tr>
<tr><td rowspan="2">1M OUTPUT TOKENS</td><td>OFF-PEAK</td><td>$0.6</td><td>$1.98</td></tr>
<tr><td>PEAK</td><td>$1.2</td><td>$3.96</td></tr>
</tbody></table>
`;

test('openai parser keeps standard prices and parses cache writes separately', async () => {
  const { parseOpenAiPricing } = await pluginsPromise.then((items) => items[0]);
  const quotes = parseOpenAiPricing(OPENAI_MARKDOWN);
  assert.equal(quotes.length, 2);
  const quote = quotes.find((item) => item.model === 'gpt-5.5');
  assert.deepEqual({
    input: quote.input,
    output: quote.output,
    cacheRead: quote.cacheRead,
    cacheWrite: quote.cacheWrite,
    cacheWrite1h: quote.cacheWrite1h
  }, {
    input: 5,
    output: 30,
    cacheRead: 0.5,
    cacheWrite: null,
    cacheWrite1h: null
  });
  assert.equal(quotes.some((item) => item.model === 'gpt-5.5' && item.input === 2.5), false);
});

test('anthropic parser does not copy 5m cache writes into 1h cache writes', async () => {
  const { parseAnthropicPricing } = await pluginsPromise.then((items) => items[1]);
  const quotes = parseAnthropicPricing(ANTHROPIC_MARKDOWN);
  const opus = quotes.find((item) => item.model === 'claude-opus-5-5');
  assert.equal(opus.cacheWrite, 5);
  assert.equal(opus.cacheWrite1h, 8);
  assert.notEqual(opus.cacheWrite, opus.cacheWrite1h);
  const haiku = quotes.find((item) => item.model === 'claude-haiku-5-5');
  assert.equal(haiku.input, 0.1);
  assert.equal(haiku.tiers.length, 1);
  assert.equal(haiku.tiers[0].when.contextTokensGt, 100000);
  assert.equal(haiku.tiers[0].input, 0.5);
});

test('google parser selects the currently effective price and ignores image models', async () => {
  const { parseGooglePricing } = await pluginsPromise.then((items) => items[2]);
  const in2026 = parseGooglePricing(GOOGLE_HTML, Date.parse('2026-10-20T00:00:00Z'));
  assert.equal(in2026.length, 1);
  assert.equal(in2026[0].model, 'gemini-3.8-flash');
  assert.equal(in2026[0].input, 0.75);
  assert.equal(in2026[0].cacheRead, 0.075);
  const in2027 = parseGooglePricing(GOOGLE_HTML, Date.parse('2027-02-01T00:00:00Z'));
  assert.equal(in2027[0].input, 1.5);
  assert.equal(in2027[0].output, 7.5);
});

test('deepseek parser uses off-peak rates and keeps the legacy flash alias', async () => {
  const { parseDeepSeekPricing } = await pluginsPromise.then((items) => items[3]);
  const quotes = parseDeepSeekPricing(DEEPSEEK_HTML);
  const pro = quotes.find((item) => item.model === 'deepseek-v4-pro');
  assert.deepEqual({ input: pro.input, output: pro.output, cacheRead: pro.cacheRead }, {
    input: 0.66,
    output: 1.98,
    cacheRead: 0.022
  });
  const flash = quotes.find((item) => item.model === 'deepseek-flash');
  assert.equal(flash.input, 0.15);
  assert.equal(flash.output, 0.6);
  assert.equal(quotes.some((item) => item.model === 'deepseek-v4-flash' && item.input === 0.15), true);
});

test('official plugin falls back to a stale offline snapshot when the source fails', async () => {
  const { loadQuotes } = await pluginsPromise.then((items) => items[0]);
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 503, text: async () => '' });
  try {
    const loaded = await loadQuotes();
    assert.equal(loaded.source.stale, true);
    assert.equal(loaded.quotes.length > 0, true);
    assert.equal(loaded.quotes.every((quote) => quote.source.stale === true), true);
  } finally {
    global.fetch = originalFetch;
  }
});
