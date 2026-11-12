'use strict';
const fs = require('node:fs'), path = require('node:path'), { execFileSync } = require('node:child_process');
const { loadPlaywright } = require('./playwright-require');
const base = 'http://127.0.0.1:9527';
let key = '';
try {
  const raw = execFileSync('sqlite3', ['file:/Users/model/.ai_home/app-state.db?mode=ro', "select value from app_kv where key='config:server';"], { encoding: 'utf8' }).trim();
  key = String(JSON.parse(raw).managementKey || '').trim();
} catch (_error) {}
const profileFor = (origin, key) => {
  const now = Date.now();
  return {
    id: 'local', stableServerId: 'local', name: 'Local', endpoint: origin,
    routes: [{ id: 'direct', kind: 'direct', endpoint: origin, viaServerId: '', health: 'healthy', rttMs: 1, failureRate: 0, consecutiveFailures: 0, lastCheckedAt: now, lastSuccessAt: now, lastFailureAt: 0, updatedAt: now }],
    activeRouteId: 'direct', authorizationState: 'authorized', connectionMode: 'direct', broker: null, state: 'ready',
    managementKey: key, managementKeyConfigured: true, nodes: [], nodeCount: 0, accountCount: 0, activeAccountCount: 0,
    schedulableAccountCount: 0, sessionCount: 0, lastNodeSyncAt: 0, lastStatusSyncAt: 0, lastAccountsSyncAt: 0,
    lastSessionsSyncAt: 0, descriptor: null, lastCheckedAt: now, lastError: '', createdAt: now, updatedAt: now
  };
};
(async () => {
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE', m.text().slice(0, 300)); });
  await page.addInitScript(({ key, profile }) => {
    localStorage.setItem('aih:control-plane-profiles:v1', JSON.stringify([profile]));
    localStorage.setItem('aih:active-control-plane-profile:v1', 'local');
  }, { key, profile: profileFor(base, key) });
  const clickFirst = async (texts) => {
    for (const text of texts) {
      const loc = page.getByText(text, { exact: false }).first();
      if (await loc.count()) { await loc.click().catch(() => {}); return text; }
    }
    return '';
  };
  await page.goto(base + '/ui/chat', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);

  // 1. 先在 Chat 模式进入已有会话，让 composer 出现。
  console.log('CHAT_CLICK', await clickFirst(['妹妹你坐船头', '坐船头', '你好，只回复 OK']));
  await page.waitForSelector('textarea', { timeout: 45000 }).catch(() => {});
  const chatReady = Boolean(await page.locator('textarea').count());
  console.log('CHAT_READY', chatReady);
  if (!chatReady) throw new Error('Chat composer 未出现');

  // 2. 在 composer 里显式选 Claude 账号。
  const account = page.locator('button').filter({ hasText: /QODER|OAuth|API Key|国际站/ }).first();
  await account.click().catch(() => {});
  await page.waitForTimeout(500);
  const claudeGroup = page.getByText('CLAUDE', { exact: true }).first();
  if (await claudeGroup.count()) {
    await claudeGroup.hover().catch(() => {});
    console.log('CLAUDE_GROUP', 'hover');
  } else {
    console.log('CLAUDE_GROUP', 'missing');
  }
  await page.waitForTimeout(600);
  console.log('ACCOUNT_CLICK', await clickFirst(['api.deepseek.com']));
  await page.waitForTimeout(3000);
  console.log('AFTER_ACCOUNT', JSON.stringify(await page.evaluate(() => document.body.innerText.slice(-240))));

  // 3. 切 WORK，选工作区，再新建会话；此时 selectedAccount 已是 Claude。
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(300);
  const workButton = page.getByRole('button', { name: /Work/ });
  const workTab = page.getByRole('tab', { name: /Work/ });
  const workRadio = page.getByRole('radio', { name: /Work/ });
  console.log('WORK_ROLE_COUNT', (await workButton.count()) + (await workTab.count()) + (await workRadio.count()));
  if (await workButton.count()) await workButton.last().click({ force: true }).catch(() => {});
  else if (await workTab.count()) await workTab.last().click({ force: true }).catch(() => {});
  else if (await workRadio.count()) await workRadio.last().click({ force: true }).catch(() => {});
  await page.waitForFunction(() => document.body.innerText.includes('新建工作区会话'), { timeout: 10000 }).catch(() => {});
  console.log('WORK_READY', await page.evaluate(() => document.body.innerText.includes('新建工作区会话')));
  console.log('WS_CLICK', await clickFirst(['AIH (Local Mac)']));
  await page.waitForTimeout(800);
  console.log('WS_BUTTONS', JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('button')].map((b) => ({ text: String(b.textContent || '').trim(), aria: b.getAttribute('aria-label') || '' })).filter((b) => /新建|新建工作区/.test(b.text + b.aria)).slice(-8))));
  const newWork = page.locator('button[aria-label="新建工作区会话"]').first();
  console.log('NEW_CLICK', await newWork.count());
  await newWork.click().catch(() => {});
  await page.waitForSelector('textarea', { timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(1200);

  console.log('BEFORE', JSON.stringify(await page.evaluate(() => ({
    textarea: Boolean(document.querySelector('textarea')),
    retry: document.body.innerText.includes('重试 AIH Chat Runtime'),
    model: document.body.innerText.slice(-200)
  }))));

  // 4. 打开审批菜单，断言菜单项 disabled 状态。
  const approval = page.locator('button').filter({ hasText: /Full access|选择审批模式|确认/ }).first();
  await approval.click().catch(() => {});
  await page.waitForTimeout(700);
  const approvalItems = await page.evaluate(() => [...document.querySelectorAll('.ant-dropdown-menu-item')].map((el) => ({
    text: String(el.textContent || '').trim(),
    disabled: el.classList.contains('ant-dropdown-menu-item-disabled') || el.getAttribute('aria-disabled') === 'true'
  })));
  console.log('APPROVAL_ITEMS', JSON.stringify(approvalItems));
  if (!approvalItems.some((item) => item.text.includes('Approve for me'))) throw new Error('missing Approve for me');
  if (!approvalItems.some((item) => item.text.includes('Plan mode'))) throw new Error('missing Plan mode');
  if (approvalItems.some((item) => /Approve for me|Plan mode/.test(item.text) && item.disabled)) {
    throw new Error('Claude 下审批菜单仍被禁用');
  }
  console.log('APPROVAL_ENABLED', true);
  fs.mkdirSync('output/playwright', { recursive: true });
  await page.screenshot({ path: 'output/playwright/chat-approval-restored-dom.png' });
  await browser.close();
})().catch((error) => { console.error(error.stack); process.exit(1); });
