#!/usr/bin/env node
// 真实页面 E2E：验证「扫描本机账号」的 skipped 摘要 toast。
//
// 说明：docs/testing/account-scan-toast-e2e.md
// 为什么用 E2E 而不是单测：仓库约定「要测就真实测试」。这里驱动线上构建的
// WebUI，只对 /v0/webui/accounts/detect 做响应 mock，从而稳定复现 skipped
// 分支，不触碰真实账号数据。
//
// 依赖：全局 playwright-cli（npm install -g @playwright/cli），以及一个
// 正在运行、已构建 WebUI 的 aih-server。
//
// 用法：
//   AIH_MANAGEMENT_KEY=... node scripts/verify-account-scan-toast.mjs
//   AIH_WEBUI_URL=http://127.0.0.1:9527/ui/ ...
//   AIH_TOAST_SCREENSHOT=/tmp/toast.png ...   # 可选，保存截图
//
// 退出码：0 通过；1 断言失败；2 环境/依赖缺失。

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

const webuiUrl = (process.env.AIH_WEBUI_URL || 'http://127.0.0.1:9527/ui/').trim();
const managementKey = (process.env.AIH_MANAGEMENT_KEY || '').trim();
const screenshotPath = (process.env.AIH_TOAST_SCREENSHOT || '').trim();

if (!managementKey) {
  console.error('AIH_MANAGEMENT_KEY is required (management key of the running server).');
  process.exit(2);
}

let accountsUrl;
try {
  const base = new URL(webuiUrl);
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  accountsUrl = new URL('accounts', base).toString();
} catch {
  console.error(`invalid AIH_WEBUI_URL: ${webuiUrl}`);
  process.exit(2);
}

const session = `toast-verify-${process.pid}`;
const tempDir = mkdtempSync(join(tmpdir(), 'aih-toast-verify-'));
const flowPath = join(tempDir, 'flow.js');

const flow = `async page => {
  const KEY = ${JSON.stringify(managementKey)};
  const WEBUI = ${JSON.stringify(webuiUrl)};
  const ACCOUNTS = ${JSON.stringify(accountsUrl)};
  const SHOT = ${JSON.stringify(screenshotPath)};

  await page.goto(WEBUI);
  await page.waitForTimeout(1200);

  // 新会话通常停在授权弹窗；已授权时直接复用现有 profile。
  const keyInput = page.locator('input[placeholder="Management Key"]:visible');
  if (await keyInput.count()) {
    await keyInput.fill(KEY);
    await page.locator('button').filter({ hasText: '保存并授权' }).last().click();
    await page.waitForTimeout(2500);
  }

  await page.goto(ACCOUNTS);
  await page.waitForTimeout(1500);

  const actionable = {
    ok: true,
    scanned: 4,
    updated: 1,
    reloaded: false,
    registered: [{ accountRef: 'acct_demo', cliAccountId: '1', created: false }],
    skipped: [
      { reason: 'credential_source_mismatch', provider: 'codebuddy', source: 'file:workbuddy-desktop-ai.info' },
      { reason: 'credential_source_mismatch', provider: 'codebuddy', source: 'file:workbuddy-desktop-ai.info' },
      { reason: 'desktop_credential_read_failed', detail: 'file is not a database (26)', provider: 'codebuddy', source: 'desktop:codebuddy' },
      { reason: 'existing_account_unchanged', provider: 'codebuddy', source: 'desktop:workbuddy' }
    ],
    accounts: { claude: 1 }
  };
  const benignOnly = {
    ok: true,
    scanned: 2,
    updated: 1,
    reloaded: false,
    registered: [{ accountRef: 'acct_demo', cliAccountId: '1', created: false }],
    skipped: [{ reason: 'existing_account_unchanged', provider: 'codebuddy', source: 'desktop:workbuddy' }],
    accounts: { claude: 1 }
  };

  let phase = 'actionable';
  await page.route('**/v0/webui/accounts/detect', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(phase === 'actionable' ? actionable : benignOnly)
  }));

  const scanButton = page.locator('button').filter({ hasText: '扫描本机账号' }).first();
  const lastToast = async () => {
    const notice = page.locator('.ant-message-notice').last();
    await notice.waitFor({ state: 'visible', timeout: 8000 });
    return (await notice.innerText()).trim();
  };

  await scanButton.click();
  const actionableToast = await lastToast();
  if (SHOT) await page.screenshot({ path: SHOT });

  // 等第一条 toast 自动消失，再验证「只有常态跳过时不追加摘要」。
  await page.waitForTimeout(3600);
  phase = 'benign';
  await scanButton.click();
  const benignToast = await lastToast();

  return { actionableToast, benignToast };
}`;

writeFileSync(flowPath, flow, { mode: 0o600 });

function runCli(args) {
  const result = spawnSync('playwright-cli', args, { encoding: 'utf8' });
  if (result.error) {
    console.error('playwright-cli not found; install with: npm install -g @playwright/cli');
    console.error(result.error.message);
    process.exit(2);
  }
  if (result.status !== 0) {
    console.error(result.stderr || result.stdout);
    process.exit(1);
  }
  return result.stdout || '';
}

function parseResult(output) {
  const marker = '### Result';
  const index = output.indexOf(marker);
  if (index < 0) return null;
  const line = output.slice(index + marker.length).split('\n').map((item) => item.trim()).find(Boolean);
  if (!line) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

let exitCode = 0;
try {
  runCli(['-s=' + session, 'open', webuiUrl]);
  const result = parseResult(runCli(['-s=' + session, 'run-code', '--filename=' + flowPath]));
  if (!result) {
    console.error('could not parse playwright-cli result');
    exitCode = 1;
  } else {
    const { actionableToast, benignToast } = result;
    const checks = [
      ['新增账号数', actionableToast.includes('扫描完成：新增/更新 1 个账号')],
      ['未入库摘要', actionableToast.includes('另有 3 个来源未入库')],
      ['同类原因合并', actionableToast.includes('凭据站点不匹配 ×2')],
      ['detail 展示', actionableToast.includes('桌面凭据库读取失败（file is not a database (26)）')],
      ['常态跳过不出现', !actionableToast.includes('账号无变化')],
      ['常态跳过不追加摘要', !benignToast.includes('另有')],
    ];
    for (const [name, ok] of checks) {
      console.log(`${ok ? 'ok' : 'FAIL'}  ${name}`);
      if (!ok) exitCode = 1;
    }
    console.log('--- actionable toast ---');
    console.log(actionableToast);
    console.log('--- benign-only toast ---');
    console.log(benignToast);
  }
} finally {
  spawnSync('playwright-cli', ['-s=' + session, 'close'], { encoding: 'utf8' });
  rmSync(tempDir, { recursive: true, force: true });
}

process.exit(exitCode);
