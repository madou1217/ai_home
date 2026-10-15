#!/usr/bin/env node
'use strict';

// WebUI 账号页额度展示的**自动化端到端校验**（零新依赖：本机 Chrome + CDP over Node 内建 WebSocket）。
//
// 为什么需要它：额度展示的契约是「服务端 payload → 展示行 → DOM 文本」三段链路。单测只能覆盖前两段
// （lib/usage/quota/view.js 与 web/src/components/account/quota-scopes.ts），真正渲染出什么字必须看
// DOM。以前这一步靠人肉开浏览器，于是「改了标签但没人看」成了常态。
//
// 它做四件事：
//   1) 从 Server 配置读 Management Key（本地回环，不打印、不落盘）；
//   2) 起一个无头 Chrome（独立临时 profile，不碰用户浏览器数据）；
//   3) 注入 Control Plane profile 后打开 /accounts，等账号表渲染完成；
//   4) 断言：服务端 payload 里的**每一个额度行标签都出现在 DOM 里**，且旁路条目（赠送/明细）带标记。
//
// 用法：
//   node scripts/webui-usage-e2e.js                 # 断言 + 摘要
//   node scripts/webui-usage-e2e.js --screenshot    # 额外存 PNG 到 /tmp
//   AIH_E2E_CHROME=/path/to/chrome AIH_E2E_ORIGIN=http://127.0.0.1:9527 node scripts/webui-usage-e2e.js
//   AIH_E2E_BASE_PATH=/ui   # WebUI 挂载前缀（默认 /ui，见 lib/server/web-ui-router.js 的静态服务）
//
// 退出码：0 = 通过；1 = 断言失败；2 = 环境不满足（无 Chrome / Server 未运行 / 无快照）。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const SERVER_ROOT = String(process.env.AIH_E2E_ORIGIN || 'http://127.0.0.1:9527').replace(/\/+$/, '');
const AI_HOME_DIR = path.resolve(process.env.AIH_HOME || path.join(os.homedir(), '.ai_home'));
const ORIGIN = String(process.env.AIH_E2E_ORIGIN || 'http://127.0.0.1:9527').replace(/\/+$/, '') + String(process.env.AIH_E2E_BASE_PATH || '/ui').replace(/\/+$/, '');
const SCREENSHOT = process.argv.includes('--screenshot');
const NAV_TIMEOUT_MS = Number(process.env.AIH_E2E_TIMEOUT_MS || 45000);

function log(line) {
  process.stdout.write(`${line}\n`);
}

function fail(code, message) {
  process.stderr.write(`[webui-usage-e2e] ${message}\n`);
  process.exit(code);
}

function chromeCandidates() {
  const explicit = String(process.env.AIH_E2E_CHROME || '').trim();
  if (explicit) return [explicit];
  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
    ];
  }
  if (process.platform === 'win32') {
    return [
      path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google/Chrome/Application/chrome.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe')
    ];
  }
  return ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'];
}

function resolveChromeBinary() {
  for (const candidate of chromeCandidates()) {
    try {
      if (candidate && fs.existsSync(candidate)) return candidate;
    } catch (_error) { /* ignore */ }
  }
  return '';
}

function readManagementKey() {
  const { readServerConfig } = require('../lib/server/server-config-store');
  const config = readServerConfig({ fs, aiHomeDir: AI_HOME_DIR });
  return String(config.managementKey || '').trim();
}

function httpJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        try {
          resolve({ statusCode: response.statusCode, body: JSON.parse(body) });
        } catch (error) {
          reject(new Error(`invalid_json:${body.slice(0, 120)}`));
        }
      });
    });
    request.on('error', reject);
    request.setTimeout(5000, () => request.destroy(new Error('http_timeout')));
  });
}

async function waitForDevtools(port, deadlineMs) {
  let lastError = null;
  while (Date.now() < deadlineMs) {
    try {
      const info = await httpJson(`http://127.0.0.1:${port}/json/version`);
      if (info.body && info.body.webSocketDebuggerUrl) return info.body;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw lastError || new Error('devtools_unavailable');
}

/** 极简 CDP 客户端（Node 内建 WebSocket，无第三方依赖）。 */
function createCdpClient(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  const pending = new Map();
  const listeners = new Set();
  let nextId = 1;

  socket.addEventListener('message', (event) => {
    let payload = null;
    try {
      payload = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
    } catch (_error) {
      return;
    }
    if (payload.id && pending.has(payload.id)) {
      const { resolve, reject } = pending.get(payload.id);
      pending.delete(payload.id);
      if (payload.error) reject(new Error(payload.error.message || 'cdp_error'));
      else resolve(payload.result);
      return;
    }
    if (payload.method) {
      for (const listener of listeners) listener(payload);
    }
  });

  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve());
    socket.addEventListener('error', (error) => reject(error));
  });

  return {
    ready,
    onEvent(listener) {
      listeners.add(listener);
    },
    send(method, params = {}, sessionId) {
      const id = nextId++;
      const message = { id, method, params };
      if (sessionId) message.sessionId = sessionId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify(message));
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error(`cdp_timeout:${method}`));
          }
        }, NAV_TIMEOUT_MS);
      });
    },
    close() {
      try { socket.close(); } catch (_error) { /* ignore */ }
    }
  };
}

/** 期望值直接从服务端 payload 派生：断言「DOM 必须体现服务端说的每一行」。 */
function buildExpectations(accounts) {
  const byProvider = new Map();
  for (const account of accounts) {
    const snapshot = account.usageSnapshot;
    if (!snapshot) continue;
    const rows = Array.isArray(snapshot.entries)
      ? snapshot.entries
      : (Array.isArray(snapshot.models) ? snapshot.models : []);
    if (rows.length === 0) continue;
    const entry = byProvider.get(account.provider) || { labels: new Set(), secondary: [], accountCount: 0, modelCounts: [], shape: String(snapshot.entryShape || '') };
    entry.accountCount += 1;
    if (String(snapshot.entryShape) === 'models') {
      // 分组展示（agy）只列有额度数字的模型：groupAgyQuotaModels 会过滤 remainingPct == null，
      // 所以「可见模型数」必须按带数值的行数比对，否则会把有意过滤当成漏渲染。
      entry.modelCounts.push(rows.filter((row) => typeof row.remainingPct === 'number').length);
    }
    for (const row of rows) {
      const label = String(row.label || row.model || '');
      if (label) entry.labels.add(label);
      if (row.category === 'gift' || row.category === 'detail') entry.secondary.push(label);
    }
    byProvider.set(account.provider, entry);
  }
  return [...byProvider.entries()].map(([provider, entry]) => ({
    provider,
    shape: entry.shape,
    accountCount: entry.accountCount,
    modelCounts: entry.modelCounts,
    labels: [...entry.labels],
    secondary: entry.secondary.filter(Boolean)
  }));
}

/**
 * 展示层对 payload 的**已知映射**（契约的一部分，owner: web/src/components/account/quota-scopes.ts）：
 * 余额桶里还有每包明细时，通用桶（credits/balance）那行是账户级总量，展示成「账户额度」。
 * E2E 必须按展示契约比对，否则会把有意的改名当成漏渲染。
 */
function expectedDisplayLabels(providerEntry) {
  const hasDetail = providerEntry.secondary.length > 0;
  return providerEntry.labels.map((label) => {
    if (!hasDetail) return label;
    if (label === 'Credits' || label === 'Balance') return '账户额度';
    return label;
  });
}

/**
 * 分组展示的账号（agy）把模型清单放在 hover tooltip 里，且默认只列 8 条。
 * 逐格悬停读取「名称 (N)」，用 N 与 payload 的模型数比对 —— 这比要求每个模型独占一行更贴合真实展示。
 */
async function collectGroupedModelCounts({ send, evaluate }) {
  const cells = JSON.parse(await evaluate(`JSON.stringify(
    Array.from(document.querySelectorAll('[data-usage-provider]')).map((cell, index) => ({
      index,
      provider: cell.getAttribute('data-usage-provider') || '',
      helpCount: cell.querySelectorAll('.usage-group-title--help').length
    })).filter((cell) => cell.helpCount > 0)
  )`) || '[]');

  const readVisibleTooltip = async () => {
    const text = await evaluate(`(() => {
      const tips = Array.from(document.querySelectorAll('.ant-tooltip:not(.ant-tooltip-hidden) .ant-tooltip-inner'));
      const last = tips[tips.length - 1];
      return last ? last.innerText : '';
    })()`);
    const matches = [...String(text || '').matchAll(/名称 \((\d+)\)/g)].map((match) => Number(match[1]));
    return matches.length > 0 ? Math.max(...matches) : 0;
  };

  const results = [];
  for (const cell of cells) {
    // 一格有多个分组（agy：Gemini / Claude & GPT / Other），逐个分组单独定位后悬停再求和。
    // 注意：必须在每次悬停前重新取坐标 —— scrollIntoView 会让先前算好的坐标失效。
    let total = 0;
    for (let helpIndex = 0; helpIndex < cell.helpCount; helpIndex += 1) {
      const box = JSON.parse(await evaluate(`(() => {
        const cell = document.querySelectorAll('[data-usage-provider]')[${cell.index}];
        const help = cell && cell.querySelectorAll('.usage-group-title--help')[${helpIndex}];
        if (!help) return 'null';
        help.scrollIntoView({ block: 'center' });
        const rect = help.getBoundingClientRect();
        return JSON.stringify({ x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) });
      })()`));
      if (!box) continue;
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, button: 'none' });
      await new Promise((resolve) => setTimeout(resolve, 700));
      total += await readVisibleTooltip();
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2, button: 'none' });
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    results.push({ provider: cell.provider, count: total, groups: cell.helpCount });
  }
  return results;
}

async function main() {
  const chromeBinary = resolveChromeBinary();
  if (!chromeBinary) fail(2, '找不到 Chrome/Chromium（可用 AIH_E2E_CHROME 指定路径）');

  const health = await httpJson(`${SERVER_ROOT}/readyz`).catch(() => null);
  if (!health) fail(2, `Server 未运行或不可达：${ORIGIN}`);

  const managementKey = readManagementKey();
  if (!managementKey) fail(2, 'Server 未配置 Management Key（aih server config set --management-key …）');

  const payloadResponse = await httpJson(`${SERVER_ROOT}/v0/webui/accounts`, {
    Authorization: `Bearer ${managementKey}`
  }).catch((error) => fail(2, `读取 /v0/webui/accounts 失败：${error.message}`));
  if (payloadResponse.statusCode !== 200) {
    fail(2, `/v0/webui/accounts 返回 ${payloadResponse.statusCode}（Management Key 是否与 Server 一致？）`);
  }
  const expectations = buildExpectations(payloadResponse.body.accounts || []);
  if (expectations.length === 0) {
    fail(2, '服务端没有任何带条目的额度快照，无法校验（先跑 aih <provider> usage 生成快照）');
  }

  const port = 9300 + Math.floor(Math.random() * 400);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-e2e-chrome-'));
  log(`[webui-usage-e2e] origin=${ORIGIN} 期望 provider=${expectations.length} chrome=${path.basename(chromeBinary)}`);
  const child = spawn(chromeBinary, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-extensions',
    '--window-size=1440,1400',
    'about:blank'
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderrTail = '';
  child.stderr.on('data', (chunk) => { stderrTail = (stderrTail + String(chunk)).slice(-2000); });

  let client = null;
  const cleanup = () => {
    if (client) client.close();
    try { child.kill('SIGKILL'); } catch (_error) { /* ignore */ }
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_error) { /* ignore */ }
  };
  process.on('exit', cleanup);

  try {
    const version = await waitForDevtools(port, Date.now() + 20000);
    client = createCdpClient(version.webSocketDebuggerUrl);
    await client.ready;
    const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
    const send = (method, params) => client.send(method, params, sessionId);
    await send('Page.enable');
    await send('Runtime.enable');

    const evaluate = async (expression) => {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) {
        throw new Error((result.exceptionDetails.exception && result.exceptionDetails.exception.description) || 'page_evaluate_failed');
      }
      return result.result.value;
    };

    // 先在同源页面上写入 Control Plane profile（含真实 Management Key），再进账号页。
    await send('Page.navigate', { url: `${ORIGIN}/` });
    await new Promise((resolve) => setTimeout(resolve, 900));
    const profile = [{
      id: 'aih-e2e-local',
      name: '当前 Server',
      endpoint: SERVER_ROOT,
      connectionMode: 'direct',
      state: 'ready',
      managementKey,
      managementKeyConfigured: true,
      routes: [{ id: 'aih-e2e-local-route', kind: 'direct', endpoint: SERVER_ROOT, connectionMode: 'direct' }],
      activeRouteId: 'aih-e2e-local-route',
      stableServerId: 'aih-e2e-local',
      lastError: '',
      createdAt: Date.now(),
      updatedAt: Date.now()
    }];
    await evaluate(`window.localStorage.setItem('aih:control-plane-profiles:v1', ${JSON.stringify(JSON.stringify(profile))}); 'ok'`);

    await send('Page.navigate', { url: `${ORIGIN}/accounts` });
    const deadline = Date.now() + NAV_TIMEOUT_MS;
    let bodyText = '';
    let domRows = '[]';
    // 按账号容器读渲染结果：data-usage-provider 由 UsageSnapshotCell 暴露，用于把额度行归属到账号。
    const readRows = `JSON.stringify(Array.from(document.querySelectorAll('[data-usage-provider]')).map((cell) => ({
      provider: cell.getAttribute('data-usage-provider') || '',
      rows: Array.from(cell.querySelectorAll('.usage-meta-line')).map((line) => ({
        label: (line.querySelector('.usage-meta-line-label') || {}).textContent || '',
        tag: (line.querySelector('.usage-meta-line-tag') || {}).textContent || ''
      }))
    })))`;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 800));
      bodyText = await evaluate("document.body ? document.body.innerText : ''");
      domRows = await evaluate(readRows);
      if (JSON.parse(domRows).length > 0) break;
    }

    // 折叠的行要点开才算「看得见」：点一遍「展开 N 项」开关（与用户操作等价），再读一次行。
    const expandClicks = await evaluate(`(() => {
      const toggles = Array.from(document.querySelectorAll('.usage-expand-toggle'));
      for (const toggle of toggles) toggle.click();
      return toggles.length;
    })()`);
    if (expandClicks > 0) {
      await new Promise((resolve) => setTimeout(resolve, 700));
      domRows = await evaluate(readRows);
    }

    const renderedCells = JSON.parse(domRows || '[]');
    const rowLabelsByProvider = new Map();
    const tagsByProvider = new Map();
    let renderedRowCount = 0;
    for (const cell of renderedCells) {
      const labels = rowLabelsByProvider.get(cell.provider) || new Set();
      const tags = tagsByProvider.get(cell.provider) || [];
      for (const row of cell.rows) {
        renderedRowCount += 1;
        if (row.label) labels.add(row.label);
        if (row.tag) tags.push(row.tag);
      }
      rowLabelsByProvider.set(cell.provider, labels);
      tagsByProvider.set(cell.provider, tags);
    }

    // 分组展示的账号（agy）：模型清单在 hover tooltip 里，逐格悬停读取「名称 (N)」。
    const groupedCells = await collectGroupedModelCounts({ send, evaluate });
    const groupedCountsByProvider = new Map();
    for (const cell of groupedCells) {
      const counts = groupedCountsByProvider.get(cell.provider) || [];
      counts.push(cell.count);
      groupedCountsByProvider.set(cell.provider, counts);
    }

    const missing = [];
    for (const expectation of expectations) {
      const labels = rowLabelsByProvider.get(expectation.provider) || new Set();
      const cells = renderedCells.filter((cell) => cell.provider === expectation.provider).length;
      if (cells < expectation.accountCount) {
        missing.push(`${expectation.provider}: 只渲染出 ${cells}/${expectation.accountCount} 个账号的额度格`);
      }
      if (expectation.shape === 'models' && expectation.modelCounts.length > 0) {
        // 分组展示：每格的 hover 清单条数必须等于该账号 payload 的模型数（清单默认只列 8 条，
        // 因此逐格比对条数才是「每个模型都可见」的诚实断言）。
        const rendered = (groupedCountsByProvider.get(expectation.provider) || []).slice().sort((a, b) => a - b);
        const wanted = expectation.modelCounts.slice().sort((a, b) => a - b);
        if (JSON.stringify(rendered) !== JSON.stringify(wanted)) {
          missing.push(`${expectation.provider}: hover 模型清单条数 ${JSON.stringify(rendered)} ≠ payload 模型数 ${JSON.stringify(wanted)}`);
        }
        continue;
      }
      for (const label of expectedDisplayLabels(expectation)) {
        if (!labels.has(label)) missing.push(`${expectation.provider}:${label}`);
      }
      const tags = tagsByProvider.get(expectation.provider) || [];
      if (expectation.secondary.length > 0 && tags.length === 0) {
        missing.push(`${expectation.provider}: 旁路条目（赠送/明细）缺少标记`);
      }
    }

    if (SCREENSHOT) {
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      const target = path.join(os.tmpdir(), 'aih-webui-accounts.png');
      fs.writeFileSync(target, Buffer.from(shot.data, 'base64'));
      log(`[webui-usage-e2e] 截图: ${target}`);
    }

    const sample = renderedCells
      .flatMap((cell) => cell.rows.map((row) => `${row.label}${row.tag ? `(${row.tag})` : ''}`))
      .slice(0, 12);
    const allTags = [...new Set(renderedCells.flatMap((cell) => cell.rows.map((row) => row.tag).filter(Boolean)))];
    log(`[webui-usage-e2e] 展开点击=${expandClicks} 渲染账号格=${renderedCells.length} 额度行=${renderedRowCount} 旁路标记=${allTags.join('/') || '无'} hover清单=${groupedCells.map((cell) => `${cell.provider}:${cell.count}`).join(',') || '无'}`);
    log(`[webui-usage-e2e] 样例: ${sample.join(' | ')}`);


    if (missing.length > 0) {
      if (bodyText.includes('server-setup')) {
        process.stderr.write('[webui-usage-e2e] 页面跳到了 /server-setup（profile 注入未生效或密钥不匹配）\n');
      }
      process.stderr.write(`[webui-usage-e2e] 未在 DOM 中渲染的额度行：${missing.slice(0, 12).join(', ')}\n`);
      fail(1, `账号页少渲染了 ${missing.length} 项额度标签`);
    }
    log(`[webui-usage-e2e] ✅ 服务端 payload 的 ${expectations.reduce((sum, item) => sum + item.labels.length, 0)} 个额度标签全部在账号页渲染`);
  } catch (error) {
    if (stderrTail.trim()) process.stderr.write(`[chrome] ${stderrTail.trim().split('\n').slice(-3).join('\n')}\n`);
    fail(1, `E2E 失败：${(error && error.message) || error}`);
  } finally {
    cleanup();
  }
}

main().catch((error) => fail(1, `未预期错误：${(error && error.stack) || error}`));
