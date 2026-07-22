/**
 * Playwright regression that does NOT require Management Key.
 *
 * Loads the built Accounts page chunk from the running WebUI and asserts
 * every catalog provider id (including qoder / qodercn) has auth-option
 * entries — the root cause of:
 *   TypeError: Cannot read properties of undefined (reading 'map')
 *
 * Also opens /ui/accounts and verifies the static shell loads without that
 * TypeError when selecting is unavailable (connection gate).
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { listProviderIds } from '../lib/provider-catalog.js';

const baseUrl = String(process.env.AIH_WEBUI_URL || 'http://127.0.0.1:9527/ui').replace(/\/$/, '');
const chromePath = String(process.env.AIH_CHROME_PATH || '').trim()
  || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

async function main() {
  const catalogIds = listProviderIds();
  console.log(`[playwright-bundle] catalog providers: ${catalogIds.join(', ')}`);

  // 1) Static dist assertion (no browser needed, but we still drive via playwright fetch)
  const browser = await chromium.launch({ headless: true, executablePath: chromePath });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error && error.message || error)));

  await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // Discover Accounts chunk URL from the HTML or known dist files.
  const distDir = path.join(process.cwd(), 'web', 'dist');
  const accountsChunk = fs.readdirSync(distDir).find((name) => (
    name.startsWith('p__Accounts') && name.endsWith('.async.js')
  ));
  if (!accountsChunk) throw new Error('p__Accounts*.async.js not found in web/dist — run npm run web:build');

  const chunkUrl = `${baseUrl}/${accountsChunk}`;
  console.log(`[playwright-bundle] fetch ${chunkUrl}`);
  const response = await page.request.get(chunkUrl);
  if (!response.ok()) throw new Error(`Failed to fetch Accounts chunk: HTTP ${response.status()}`);
  const source = await response.text();

  const missing = [];
  for (const id of catalogIds) {
    // Minified form: qoder:[{value:"oauth-browser" ...
    const re = new RegExp(`${id}:\\s*\\[\\s*\\{`);
    if (!re.test(source)) missing.push(id);
  }
  if (missing.length) {
    throw new Error(`Accounts chunk missing auth options for: ${missing.join(', ')}`);
  }
  console.log('[playwright-bundle] all catalog providers present in PROVIDER_AUTH_OPTIONS bundle');

  // Specific crash providers
  for (const id of ['qoder', 'qodercn']) {
    if (!source.includes(`${id}:[{value:"oauth-browser"`) && !source.includes(`${id}:[{value:'oauth-browser'`)) {
      // looser check already passed via re above
      console.log(`[playwright-bundle] provider ${id} present (loose)`);
    } else {
      console.log(`[playwright-bundle] provider ${id} oauth-browser option present`);
    }
  }

  // 2) Open accounts route; ensure the infamous map TypeError is not thrown on load
  pageErrors.length = 0;
  await page.goto(`${baseUrl}/accounts`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(1500);
  const mapErrors = pageErrors.filter((msg) => /Cannot read properties of undefined \(reading 'map'\)/i.test(msg));
  if (mapErrors.length) {
    throw new Error(`Accounts page load threw map crash:\n${mapErrors.join('\n')}`);
  }
  console.log('[playwright-bundle] /ui/accounts loaded without undefined.map crash');

  await page.screenshot({ path: 'test/playwright-accounts-bundle-ok.png', fullPage: true });
  console.log('[playwright-bundle] PASS');
  await browser.close();
}

main().catch((error) => {
  console.error('[playwright-bundle] FAIL', error && error.message ? error.message : error);
  process.exitCode = 1;
});
