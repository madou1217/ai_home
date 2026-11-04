'use strict';

// ZCode 桌面端逐账号启动检查（可重复运行）。
//
// 用途：登录/重新登录之后，一次性确认每个 zcode 账号都能真正打开桌面端，
// 并输出可提交的证据表。判定标准：
//   * open-app 返回 200 且进程 ZCode-<hash> 起来；
//   * 应用日志出现 `provider/model 就绪` 或 `providerCount>0`（模型可用）；
//   * 否则记为失败（409 account_auth_invalid / Welcome / 无进程）。
//
// 用法：
//   HOME=/Users/model node scripts/zcode-desktop-launch-matrix.js [--json]
//   AIH_MANAGEMENT_KEY=... node scripts/...   # 跳过 CLI 读取
//
// 注意：会真的启动/关闭桌面窗口，每台机器同一时间只应有一个实例在跑。

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const nodeCrypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const BASE_URL = process.env.AIH_SERVER_URL || 'http://127.0.0.1:9527';
const OPEN_TIMEOUT_MS = Number(process.env.AIH_OPEN_TIMEOUT_MS || 45_000);
const SETTLE_MS = Number(process.env.AIH_OPEN_SETTLE_MS || 12_000);

function readManagementKey() {
  const fromEnv = String(process.env.AIH_MANAGEMENT_KEY || '').trim();
  if (fromEnv) return fromEnv;
  const raw = execFileSync(process.execPath, [path.join(ROOT, 'bin', 'ai-home.js'), 'server', 'config', '--show-secrets', '--json'], {
    encoding: 'utf8',
    env: process.env
  });
  const parsed = JSON.parse(raw);
  return String((parsed.config && parsed.config.managementKey) || '').trim();
}

async function api(key, pathname, init = {}) {
  const response = await fetch(BASE_URL + pathname, {
    ...init,
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', ...(init.headers || {}) }
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_error) { json = null; }
  return { status: response.status, ok: response.ok, json, text };
}

function instanceName(accountRef) {
  const hash = nodeCrypto.createHash('sha256').update(accountRef).digest('hex').slice(0, 8);
  return 'ZCode-' + hash;
}

function processRunning(name) {
  const out = spawnSync('ps', ['-Ao', 'command'], { encoding: 'utf8' });
  return String(out.stdout || '').includes(name);
}

function waitForProcess(name, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (processRunning(name)) return true;
    spawnSync('sleep', ['0.5']);
  }
  return false;
}

function readAppLogTail(accountRef, projectRoot, maxLines = 400) {
  // 日志文件名是**本地日期**（不是 UTC）：凌晨跑检查时用 toISOString 会读到昨天的文件。
  const now = new Date();
  const day = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
  const file = path.join(projectRoot, '.zcode', 'v2', 'logs', day + '.log');
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    return lines.slice(-maxLines).join('\n');
  } catch (_error) {
    return '';
  }
}

function summarizeLog(logText, sinceMs) {
  const lines = String(logText || '').split('\n').filter((line) => {
    const m = /^\[(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)\./.exec(line);
    if (!m) return false;
    return Date.parse(m[1].replace(' ', 'T') + '+08:00') >= sinceMs;
  });
  const ready = lines.some((line) => line.includes('provider/model 就绪'));
  const countMatch = lines.map((line) => /providerCount"?\s*:\s*(\d+)/.exec(line)).filter(Boolean).pop();
  const expired = lines.some((line) => /login JWT expired|session has expired/i.test(line));
  return {
    ready,
    providerCount: countMatch ? Number(countMatch[1]) : 0,
    expired,
    sample: lines.filter((line) => /provider\/model|providerCount|expired|已交付/.test(line)).slice(-3)
  };
}

async function main() {
  const key = readManagementKey();
  if (!key) {
    console.error('management key 未配置');
    process.exit(2);
  }
  const accounts = await api(key, '/v0/webui/accounts');
  if (!accounts.ok || !accounts.json) {
    console.error('读取账号失败', accounts.status);
    process.exit(2);
  }
  const zcode = (accounts.json.accounts || []).filter((item) => item.provider === 'zcode');
  const dryRun = process.argv.includes('--dry-run');
  const projectRoot = (ref) => path.join(os.homedir(), '.ai_home', 'run', 'auth-projections', 'zcode', ref);
  const results = [];
  for (const account of zcode) {
    const ref = account.accountRef;
    if (dryRun) {
      // 不启动窗口也能判断「这个账号能不能开桌面端」：桌面端只认 access_token，
      // 服务端已经把过期且无 refresh_token 的会话发布成 auth_invalid。
      const canOpen = String(account.runtimeStatus || '').toLowerCase() !== 'auth_invalid';
      const reason = String(account.runtimeReason || '').trim();
      results.push({ account: account.displayName || ref, ref, canOpen, reason, pass: canOpen });
      console.log((canOpen ? 'CAN_OPEN' : 'REAUTH_REQUIRED') + '  ' + (account.displayName || ref) + '  ' + ref + (reason ? '  reason=' + reason : ''));
      continue;
    }
    const name = account.displayName || ref;
    const inst = instanceName(ref);
    const startedAt = Date.now();
    await api(key, '/v0/webui/accounts/zcode/' + ref + '/open-app', {
      method: 'POST',
      body: JSON.stringify({ kind: 'desktop', action: 'close' })
    }).catch(() => null);
    spawnSync('sleep', ['1']);
    const open = await api(key, '/v0/webui/accounts/zcode/' + ref + '/open-app', {
      method: 'POST',
      body: JSON.stringify({ kind: 'desktop', action: 'open' })
    });
    let outcome = {
      account: name, ref, instance: inst,
      http: open.status,
      error: (open.json && open.json.error) || '',
      launched: Boolean(open.json && open.json.ok),
      processUp: false,
      ready: false,
      providerCount: 0,
      expired: false,
      sample: []
    };
    if (outcome.launched) {
      outcome.processUp = waitForProcess(inst, OPEN_TIMEOUT_MS);
      if (outcome.processUp) {
        spawnSync('sleep', [String(Math.max(1, Math.round(SETTLE_MS / 1000)))]);
        const log = summarizeLog(readAppLogTail(ref, projectRoot(ref)), startedAt - 5_000);
        outcome = { ...outcome, ...log };
      }
      await api(key, '/v0/webui/accounts/zcode/' + ref + '/open-app', {
        method: 'POST',
        body: JSON.stringify({ kind: 'desktop', action: 'close' })
      }).catch(() => null);
    }
    const pass = outcome.launched && outcome.processUp && (outcome.ready || outcome.providerCount > 0);
    outcome.pass = pass;
    results.push(outcome);
    console.log((pass ? 'PASS' : 'FAIL') + '  ' + name + '  ' + ref + '  http=' + outcome.http
      + (outcome.error ? '  error=' + outcome.error : '')
      + '  pc=' + outcome.providerCount + (outcome.expired ? '  expired' : ''));
  }
  const failed = results.filter((item) => !item.pass);
  if (process.argv.includes('--json')) console.log(JSON.stringify(results, null, 2));
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' 通过');
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('检查失败：', error && error.message || error);
  process.exit(2);
});
