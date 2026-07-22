/**
 * Playwright smoke: enter workspace via saved Server profile, open Accounts
 * add-modal, select every catalog provider. Guards against:
 *   TypeError: Cannot read properties of undefined (reading 'map')
 * when PROVIDER_AUTH_OPTIONS is missing a catalog provider id.
 *
 * Usage:
 *   node test/playwright-accounts-add-provider.mjs
 * Optional:
 *   AIH_WEBUI_URL=http://127.0.0.1:9527/ui
 *   AIH_CHROME_PATH="C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
 *   AIH_MANAGEMENT_KEY=***   # only if no saved profile exists
 */
import { chromium } from 'playwright-core';

const baseUrl = String(process.env.AIH_WEBUI_URL || 'http://127.0.0.1:9527/ui').replace(/\/$/, '');
const accountsUrl = `${baseUrl}/accounts`;
const chromePath = String(process.env.AIH_CHROME_PATH || '').trim()
  || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const managementKey = String(process.env.AIH_MANAGEMENT_KEY || '').trim();
const serverUrl = String(process.env.AIH_SERVER_URL || 'http://127.0.0.1:9527').replace(/\/$/, '');

const REQUIRED_PROVIDERS = [
  'codex', 'gemini', 'claude', 'agy', 'opencode', 'grok', 'qoder', 'qodercn', 'kimi', 'kiro'
];

const LABEL_MAP = {
  codex: /ChatGPT/i,
  gemini: /Gemini/i,
  claude: /Claude/i,
  agy: /Antigravity/i,
  opencode: /OpenCode/i,
  grok: /Grok/i,
  qoder: /^Qoder$/,
  qodercn: /Qoder\s*CN/i,
  kimi: /Kimi/i,
  kiro: /Kiro/i
};

async function seedManagementKey(page) {
  if (!managementKey) return false;
  await page.addInitScript(({ key, url }) => {
    const profile = {
      id: 'playwright-local',
      name: 'Playwright Local',
      endpoint: url,
      serverUrl: url,
      managementKey: key,
      managementKeyConfigured: true,
      authorizationState: 'authorized',
      state: 'ready',
      connectionMode: 'direct'
    };
    try {
      window.localStorage.setItem('aih:control-plane-profiles:v1', JSON.stringify({
        version: 1,
        activeId: profile.id,
        profiles: [profile]
      }));
    } catch (_error) { /* ignore */ }
  }, { key: managementKey, url: serverUrl });
  return true;
}

async function enterWorkspace(page) {
  // Prefer explicit workspace entry.
  const enterButtons = [
    page.getByRole('button', { name: /进入工作台/i }),
    page.getByRole('button', { name: /进入/i }),
    page.locator('button').filter({ hasText: /进入工作台|使用此 Server|连接/i })
  ];
  for (const btn of enterButtons) {
    if (await btn.count()) {
      try {
        await btn.first().click({ timeout: 5000 });
        await page.waitForTimeout(1200);
        return true;
      } catch (_error) { /* next */ }
    }
  }

  // Click a saved server row if listed.
  const savedRow = page.locator('tr, .ant-list-item, .ant-table-row, [class*="server"]').filter({
    hasText: /127\.0\.0\.1:9527|localhost:9527|当前 Server|已保存/
  }).first();
  if (await savedRow.count()) {
    try {
      await savedRow.click({ timeout: 3000 });
      await page.waitForTimeout(500);
      const enter = page.getByRole('button', { name: /进入|使用|连接/i }).first();
      if (await enter.count()) await enter.click({ timeout: 5000 });
      await page.waitForTimeout(1200);
      return true;
    } catch (_error) { /* ignore */ }
  }
  return false;
}

async function openAddModal(page) {
  const candidates = [
    page.getByRole('button', { name: /添加账号/i }),
    page.locator('button').filter({ hasText: /添加账号/i }),
    page.locator('.ant-btn-primary').filter({ hasText: /添加/i })
  ];
  for (const locator of candidates) {
    if (await locator.count()) {
      await locator.first().click({ timeout: 8000 });
      return true;
    }
  }
  return false;
}

async function selectProvider(page, provider) {
  const modal = page.locator('.ant-modal').filter({ hasText: /供应商|认证方式/i }).last();
  await modal.waitFor({ state: 'visible', timeout: 10000 });
  await modal.locator('.ant-select').first().click();
  await page.waitForTimeout(200);
  const dropdown = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)');
  await dropdown.waitFor({ state: 'visible', timeout: 5000 });

  if (provider === 'qoder') {
    // Exact label Qoder, not Qoder CN
    const exact = dropdown.locator('.ant-select-item-option').filter({ hasText: /^Qoder$/ });
    if (await exact.count()) {
      await exact.first().click();
      return;
    }
  }
  if (provider === 'qodercn') {
    const cn = dropdown.locator('.ant-select-item-option').filter({ hasText: /Qoder\s*CN/i });
    if (await cn.count()) {
      await cn.first().click();
      return;
    }
  }

  const pattern = LABEL_MAP[provider] || new RegExp(provider, 'i');
  const option = dropdown.locator('.ant-select-item-option').filter({ hasText: pattern }).first();
  await option.waitFor({ state: 'visible', timeout: 8000 });
  await option.click();
}

async function main() {
  const browser = await chromium.launch({ headless: true, executablePath: chromePath });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error && error.message || error)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const text = msg.text();
      if (/TypeError|Cannot read properties of undefined/i.test(text)) pageErrors.push(text);
    }
  });

  const seeded = await seedManagementKey(page);
  console.log(`[playwright] management_key_seeded=${seeded}`);

  // Land on UI root first so connection gate can use saved profile.
  console.log(`[playwright] goto ${baseUrl}/`);
  await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(1500);
  await enterWorkspace(page);

  console.log(`[playwright] goto ${accountsUrl}`);
  await page.goto(accountsUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(1500);
  await enterWorkspace(page);

  const bodyText = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
  console.log(`[playwright] body preview: ${bodyText.slice(0, 200)}`);

  if (!(await openAddModal(page))) {
    await page.screenshot({ path: 'test/playwright-accounts-add-failed.png', fullPage: true });
    throw new Error(
      'Could not open Add Account modal. Connect a Server in the UI once, or set AIH_MANAGEMENT_KEY. '
      + 'Screenshot: test/playwright-accounts-add-failed.png'
    );
  }

  await page.locator('.ant-modal').last().waitFor({ state: 'visible', timeout: 10000 });
  console.log('[playwright] add modal open');

  for (const provider of REQUIRED_PROVIDERS) {
    pageErrors.length = 0;
    console.log(`[playwright] select provider=${provider}`);
    await selectProvider(page, provider);
    await page.waitForTimeout(400);
    const fatal = pageErrors.filter((m) => /Cannot read properties of undefined \(reading 'map'\)|TypeError/i.test(m));
    if (fatal.length) {
      await page.screenshot({ path: `test/playwright-accounts-${provider}-error.png`, fullPage: true });
      throw new Error(`Provider "${provider}" page error:\n${fatal.join('\n')}`);
    }
    const radioCount = await page.locator('.ant-modal .ant-radio-wrapper').count();
    console.log(`[playwright] provider=${provider} authRadios=${radioCount}`);
    if (radioCount < 1) throw new Error(`Provider "${provider}" rendered zero auth modes`);
  }

  await page.screenshot({ path: 'test/playwright-accounts-add-ok.png', fullPage: true });
  console.log('[playwright] PASS all providers selectable without map crash');
  await browser.close();
}

main().catch((error) => {
  console.error('[playwright] FAIL', error && error.message ? error.message : error);
  process.exitCode = 1;
});
