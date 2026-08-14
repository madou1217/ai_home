const { chromium } = require('/Users/model/.npm/_npx/86170c4cd1c5da32/node_modules/playwright');
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

async function runE2E() {
  console.log('=== Step 1: 读取本地 Server 配置 ===');
  const dbPath = path.join(process.env.HOME, '.ai_home', 'app-state.db');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const row = db.prepare('SELECT value FROM app_kv WHERE key = ?').get('config:server');
  db.close();

  if (!row) {
    throw new Error('未找到 config:server 配置');
  }

  const serverConfig = JSON.parse(row.value);
  const managementKey = serverConfig.managementKey || serverConfig.management_key;
  if (!managementKey) {
    throw new Error('未找到 managementKey');
  }
  console.log('成功读取本地服务配置 (Key已准备)');

  console.log('=== Step 2: 启动 Playwright 浏览器 ===');
  const browser = await chromium.launch({
    headless: true,
    executablePath: '/Users/model/Library/Caches/ms-playwright/chromium-1229/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 }
  });
  const page = await context.newPage();

  console.log('=== Step 3: 通过 Context InitScript 注入 Ready Server Profile ===');
  const profileId = 'e2e-local-server';
  const profile = {
    id: profileId,
    name: 'Local AIH Server',
    endpoint: 'http://127.0.0.1:9527',
    state: 'ready',
    managementKey: managementKey,
    managementKeyConfigured: true,
    connectionMode: 'direct',
    schedulableAccountCount: 1,
    sessionCount: 1
  };

  await context.addInitScript(({ storageKey, activeKey, profile, profileId }) => {
    window.localStorage.setItem(storageKey, JSON.stringify([profile]));
    window.localStorage.setItem(activeKey, profileId);
  }, {
    storageKey: 'aih:control-plane-profiles:v1',
    activeKey: 'aih:active-control-plane-profile:v1',
    profile,
    profileId
  });

  console.log('=== Step 4: 打开 Chat 会话页面 ===');
  await page.goto('http://127.0.0.1:9527/ui/chat', { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForTimeout(2000);

  // 先点击左侧项目列表的第一个项目(ai-home)以打开项目
  console.log('打开左侧第一个项目...');
  const projectRow = await page.$('[class*="projectHeader"], [class*="projectName"], [class*="projectRow"]');
  if (projectRow) {
    await projectRow.click();
    await page.waitForTimeout(1500);
  }

  // 点击左侧顶部“新建会话”图标按钮
  const newSessionBtn = await page.$('button[title="新建会话"]');
  if (newSessionBtn) {
    console.log('点击“新建会话”按钮 (button[title="新建会话"])...');
    await newSessionBtn.click();
    await page.waitForTimeout(2500);
  }

  // 截取点击新建会话后的界面
  await page.screenshot({ path: '/tmp/aih_e2e_step4_chat.png' });
  console.log('已保存步骤 4 截图到 /tmp/aih_e2e_step4_chat.png');

  // 找到已启用的输入框
  let composer = null;
  try {
    composer = await page.waitForSelector('textarea:not([disabled])', { timeout: 8000 });
  } catch (_e) {
    console.log('未在 8s 内找到激活的输入框，尝试直接抓取现有会话消息...');
  }
  if (composer) {
    console.log('找到已激活的输入框，输入测试消息并发送...');
    await composer.fill('快速计算 50 + 50 等于几？请只回复一个数字。');
    await page.waitForTimeout(500);
    const sendBtn = await page.$('button[aria-label="发送消息"], button:has-text("发送")');
    if (sendBtn) {
      await sendBtn.click();
      console.log('已发送，等待流式回复及指标结算 (14s)...');
      await page.waitForTimeout(14000);
    }
  }

  // 截取最终包含性能指标气泡的界面
  await page.screenshot({ path: '/tmp/aih_e2e_metrics_result.png', fullPage: true });
  console.log('已保存指标结果截图到 /tmp/aih_e2e_metrics_result.png');

  // 检查页面中的 MessageMetaRow / MessageMetricItem
  const metaDetails = await page.$$eval('[class*="messageMetaDetails"]', els => {
    return els.map(e => e.innerText.replace(/\n/g, ' ').trim());
  });
  console.log('抓取到的 MessageMetaDetails 内容:', metaDetails);

  // 检查具体指标项类名
  const metricItems = await page.$$eval('[class*="messageMetricItem"]', els => {
    return els.map(e => e.innerText.trim());
  });
  console.log('抓取到的 MessageMetricItem 内容:', metricItems);

  await browser.close();
  console.log('=== E2E 测试全部完成 ===');
}

runE2E().catch(err => {
  console.error('E2E 测试失败:', err);
  process.exit(1);
});
