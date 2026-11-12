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
  const firstSession=page.locator('[data-flip-key^="session-"]').first();
  console.log('CHAT_CLICK', await firstSession.count());
  await firstSession.click().catch(() => {});
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

  // 3. 先关任务队列/菜单浮层，再切 WORK，选工作区，新建会话。
  await page.keyboard.press('Escape').catch(() => {});
  await page.mouse.click(1380, 900).catch(() => {});
  await page.waitForTimeout(600);
  const workByAria = page.locator('button[aria-label="工作区项目模式"]').last();
  console.log('WORK_ARIA_COUNT', await workByAria.count());
  await workByAria.click({ force: true }).catch(() => {});
  await page.waitForTimeout(1200);
  console.log('WORK_READY', Boolean(await page.locator('button[aria-label="新建工作区会话"]').count()));
  console.log('WS_CLICK', await clickFirst(['AIH (LOCAL MAC)', 'AIH (Local Mac)']));
  await page.waitForTimeout(1000);
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
  console.log('BUTTONS', JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('button')].map((b) => ({ label: b.getAttribute('aria-label') || '', text: String(b.textContent || '').trim() })).filter((b) => /审批|Full|通过|模式/.test(b.label + b.text)))));
  const approval = page.locator('button').filter({ hasText: /Full access|Approve for me|选择审批模式|确认/ }).first();
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

  // 5. 再切回 Antigravity，断言受限菜单项在 DOM 上真的 disabled。
  await page.keyboard.press('Escape').catch(() => {});
  const accountAgain = page.locator('button').filter({ hasText: /OAuth|API Key/ }).first();
  await accountAgain.click().catch(() => {});
  await page.waitForTimeout(500);
  console.log('ANTIGRAVITY_GROUP', await page.getByText('ANTIGRAVITY', { exact: true }).count());
  await page.getByText('ANTIGRAVITY', { exact: true }).first().click().catch(() => {});
  await page.waitForTimeout(500);
  await page.getByText('ma****17@126.com', { exact: true }).first().click().catch(() => {});
  await page.waitForTimeout(5000);
  const restrictedApproval = page.locator('button[aria-label="选择审批模式"]').first();
  await restrictedApproval.click().catch(() => {});
  await page.waitForTimeout(700);
  const restrictedItems = await page.evaluate(() => [...document.querySelectorAll('.ant-dropdown-menu-item')].map((el) => ({
    text: String(el.textContent || '').trim(),
    disabled: el.classList.contains('ant-dropdown-menu-item-disabled') || el.getAttribute('aria-disabled') === 'true'
  })));
  console.log('RESTRICTED_ITEMS', JSON.stringify(restrictedItems));
  const restrictedApprove = restrictedItems.find((item) => item.text.includes('Approve for me'));
  const restrictedPlan = restrictedItems.find((item) => item.text.includes('Plan mode'));
  if (!restrictedApprove || !restrictedApprove.disabled) throw new Error('Antigravity Approve for me 未 disabled');
  if (!restrictedPlan || !restrictedPlan.disabled) throw new Error('Antigravity Plan mode 未 disabled');
  console.log('RESTRICTED_DISABLED', true);
  await page.screenshot({ path: 'output/playwright/chat-approval-restricted-dom.png' });

  fs.mkdirSync('output/playwright', { recursive: true });
  await page.screenshot({ path: 'output/playwright/chat-approval-restored-dom.png' });
  await browser.close();
})().catch((error) => { console.error(error.stack); process.exit(1); });
