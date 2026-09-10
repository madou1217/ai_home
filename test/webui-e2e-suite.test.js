'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('child_process');
const fs = require('node:fs');
const http = require('node:http');

// 本用例依赖三样只存在于开发机的东西：npx 缓存里的 playwright、绝对路径写死的
// chromium 二进制、以及 127.0.0.1:9527 上活着的网关。任一缺失时它必然失败——
// 这正是 CI 长期全红、进而失去信号的原因之一。缺前置条件时如实 skip，而不是红着。
const PLAYWRIGHT_NODE_PATH = '/Users/model/.npm/_npx/86170c4cd1c5da32/node_modules';
const CHROMIUM_PATH = '/Users/model/Library/Caches/ms-playwright/chromium_headless_shell-1229/chrome-headless-shell-mac-arm64/chrome-headless-shell';

function missingPrecondition() {
  if (!fs.existsSync(PLAYWRIGHT_NODE_PATH)) return `playwright 未安装于 ${PLAYWRIGHT_NODE_PATH}`;
  if (!fs.existsSync(CHROMIUM_PATH)) return `chromium 二进制缺失：${CHROMIUM_PATH}`;
  return null;
}

/** 网关必须真的在监听，否则整轮跑完只会得到一堆连接错误。 */
function gatewayUnreachable() {
  const done = new Promise((resolve) => {
    const req = http.get('http://127.0.0.1:9527/ui', { timeout: 1500 }, (res) => {
      res.resume();
      resolve(null);
    });
    req.on('error', () => resolve('本机网关 127.0.0.1:9527 未响应'));
    req.on('timeout', () => { req.destroy(); resolve('本机网关 127.0.0.1:9527 超时'); });
  });
  return done;
}

test('Playwright full-site e2e suite verifies PC and Mobile views without errors or overflow', async (t) => {
  const missing = missingPrecondition() || await gatewayUnreachable();
  if (missing) {
    t.skip(`缺少本地前置条件，跳过端到端用例：${missing}`);
    return;
  }
  const result = execSync(
    'NODE_PATH="/Users/model/.npm/_npx/86170c4cd1c5da32/node_modules" node -e \'\nconst { chromium } = require("playwright");\nconst { execSync } = require("child_process");\n\nconst configOutput = execSync("aih server config show --show-secrets", { encoding: "utf8" });\nconst mgmtKeyMatch = configOutput.match(/management_key:\\s*([^\\s]+)/) || configOutput.match(/Management Key:\\s*([^\\s]+)/) || configOutput.match(/managementKey["\\s:]+([^\\s",]+)/);\nconst mgmtKey = mgmtKeyMatch ? mgmtKeyMatch[1] : "";\n\n(async () => {\n  const browser = await chromium.launch({\n    executablePath: "/Users/model/Library/Caches/ms-playwright/chromium_headless_shell-1229/chrome-headless-shell-mac-arm64/chrome-headless-shell",\n    headless: true\n  });\n  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });\n\n  const errors = [];\n  page.on("pageerror", err => errors.push("PAGE_ERROR: " + err.message));\n  page.on("console", msg => {\n    const text = msg.text();\n    if (msg.type() === "error" && !text.includes("favicon") && !text.includes("404")) {\n      errors.push("CONSOLE_ERROR: " + text);\n    }\n  });\n\n  await page.goto("http://127.0.0.1:9527/ui/chat", { waitUntil: "domcontentloaded" });\n  await page.waitForTimeout(500);\n\n  const keyInput = page.locator("input[type=\\"password\\"], input[placeholder*=\\"Management\\"], input[placeholder*=\\"密钥\\"]").first();\n  if (await keyInput.isVisible()) {\n    await keyInput.fill(mgmtKey);\n    const submitBtn = page.locator("button:has-text(\\"连接\\"), button:has-text(\\"Connect\\")").first();\n    await submitBtn.click();\n    await page.waitForTimeout(1500);\n  }\n\n  // Test main routes\n  const routes = ["/ui/chat", "/ui/accounts", "/ui/models", "/ui/usage", "/ui/dashboard"];\n  for (const route of routes) {\n    await page.goto("http://127.0.0.1:9527" + route, { waitUntil: "domcontentloaded" });\n    await page.waitForTimeout(500);\n    \n    // Check mobile overflow\n    await page.setViewportSize({ width: 390, height: 844 });\n    await page.waitForTimeout(300);\n    const scrollW = await page.evaluate(() => document.documentElement.scrollWidth);\n    const clientW = await page.evaluate(() => document.documentElement.clientWidth);\n    if (scrollW > clientW) {\n      errors.push(`OVERFLOW on ${route}: scrollWidth ${scrollW} > clientWidth ${clientW}`);\n    }\n    await page.setViewportSize({ width: 1440, height: 900 });\n  }\n\n  await browser.close();\n  if (errors.length > 0) {\n    console.error(JSON.stringify(errors));\n    process.exit(1);\n  }\n  console.log("ALL_ROUTES_PASSED");\n})();\n\'',
    { encoding: 'utf8' }
  );

  assert.ok(result.includes('ALL_ROUTES_PASSED'), 'All routes should pass Playwright verification');
});
