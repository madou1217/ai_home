'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { loadPlaywright } = require('./playwright-require');

const baseUrl = process.env.AIH_WEBUI_URL || 'http://127.0.0.1:9527';
function resolveManagementKey() {
  if (process.env.AIH_WEBUI_MANAGEMENT_KEY) return process.env.AIH_WEBUI_MANAGEMENT_KEY.trim();
  try {
    const pids = execFileSync('pgrep', ['-f', 'bin/native/darwin-arm64/aih-server'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    for (const pid of pids) {
      const command = execFileSync('ps', ['eww', '-p', pid, '-o', 'command='], { encoding: 'utf8' });
      const match = command.match(/AIH_SERVER_MANAGEMENT_KEY=(\S+)/);
      if (match) return match[1];
    }
  } catch (_error) {}
  const keyFile = process.env.AIH_WEBUI_KEY_FILE || '/Users/model/.ai_home/run/.tmp-key';
  return fs.existsSync(keyFile) ? fs.readFileSync(keyFile, 'utf8').trim() : '';
}
const managementKey = resolveManagementKey();
const output = process.env.AIH_CHAT_SCREENSHOT || path.join(process.cwd(), 'output/playwright/chat-capability-live.png');

function profileFor(origin, key) {
  const now = Date.now();
  return {
    id: 'local', stableServerId: 'local', name: 'Local', endpoint: origin,
    routes: [{
      id: 'direct', kind: 'direct', endpoint, viaServerId: '', health: 'healthy',
      rttMs: 1, failureRate: 0, consecutiveFailures: 0,
      lastCheckedAt: now, lastSuccessAt: now, lastFailureAt: 0, updatedAt: now
    }],
    activeRouteId: 'direct', authorizationState: 'authorized', connectionMode: 'direct',
    broker: null, state: 'ready', managementKey: key, managementKeyConfigured: true,
    nodes: [], nodeCount: 0, accountCount: 0, activeAccountCount: 0, schedulableAccountCount: 0,
    sessionCount: 0, lastNodeSyncAt: 0, lastStatusSyncAt: 0, lastAccountsSyncAt: 0, lastSessionsSyncAt: 0,
    descriptor: null, lastCheckedAt: now, lastError: '', createdAt: now, updatedAt: now
  };
}

(async () => {
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  if (managementKey) {
    await page.addInitScript(({ key, origin }) => {
      const profile = profileFor(origin, key);
      localStorage.setItem('aih:control-plane-profiles:v1', JSON.stringify([profile]));
      localStorage.setItem('aih:active-control-plane-profile:v1', 'local');
    }, { key: managementKey, origin: baseUrl });
  }
  await page.goto(baseUrl + '/ui/chat', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1200);
  await page.getByText('工作区项目模式').first().click().catch(() => {});
  await page.waitForTimeout(1200);
  const workItem = page.locator('text=WORK').first();
  await workItem.click().catch(() => {});
  await page.waitForTimeout(800);
  await page.locator('div').filter({ hasText: /./ }).first();
  await page.getByText('AIH (Local Mac)').first().click().catch(() => {});
  await page.waitForTimeout(1000);
  await page.getByText('新建工作区会话').first().click().catch(() => {});
  await page.waitForTimeout(12000);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  await page.getByText('Full access').first().click().catch(() => {});
  await page.waitForTimeout(500);
  await page.screenshot({ path: output, fullPage: false });
  const state = await page.evaluate(() => ({
    title: document.title,
    url: location.href,
    textarea: Boolean(document.querySelector('textarea')),
    approvalButtons: [...document.querySelectorAll('button')].filter((b) => /Plan|确认|confirm/i.test(b.getAttribute('aria-label') || b.textContent || '')).length,
    buttonLabels: [...document.querySelectorAll('button')].map((b) => (b.getAttribute('aria-label') || b.textContent || '').trim()).filter(Boolean).slice(-20)
  }));
  console.log(JSON.stringify({ screenshot: output, hasKey: Boolean(managementKey), ...state }));
  await browser.close();
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
