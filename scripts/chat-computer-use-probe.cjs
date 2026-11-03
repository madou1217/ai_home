'use strict';

// Computer-use 测试：用真实浏览器驱动 WebUI 对话面板，验证 workbuddy 会话能收到回复。
//
// 为什么必须走真实浏览器：这条链路的失败模式（harness 目录竞态、网关 profile 选择、
// 前端 SSE 解析）都只在「页面真的加载并发消息」时才出现；curl 打 API 只能验证后端一半。
//
// 用法：
//   node scripts/chat-computer-use-probe.cjs --base http://127.0.0.1:9527 --key <mgmt-key>
//     [--session <sessionId>] [--prompt "say PONG"] [--shot out.png] [--headful]

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { loadPlaywright } = require('./playwright-require');

function parseArgs(argv) {
  const out = { base: 'http://127.0.0.1:9527', key: '', session: '', prompt: 'reply with exactly: COMPUTER-OK', shot: '', headful: false, timeoutMs: 180000 };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = String(argv[i] || '');
    const next = argv[i + 1];
    if (arg === '--base') { out.base = String(next || '').replace(/\/+$/, ''); i += 1; }
    else if (arg === '--key') { out.key = String(next || ''); i += 1; }
    else if (arg === '--session') { out.session = String(next || ''); i += 1; }
    else if (arg === '--prompt') { out.prompt = String(next || ''); i += 1; }
    else if (arg === '--shot') { out.shot = String(next || ''); i += 1; }
    else if (arg === '--timeout-ms') { out.timeoutMs = Number(next) || out.timeoutMs; i += 1; }
    else if (arg === '--headful') { out.headful = true; }
  }
  return out;
}

// 已缓存的 chromium 版本可能与 playwright 期望的不一致（下载被网络策略拦住时），
// 因此显式挑一个真实存在的可执行文件，而不是让 playwright 自己去找。
function resolveExecutable() {
  const cacheRoot = path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
  const candidates = [];
  try {
    fs.readdirSync(cacheRoot)
      .filter((name) => name.startsWith('chromium_headless_shell-'))
      .sort()
      .reverse()
      .forEach((name) => candidates.push(path.join(cacheRoot, name, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell')));
    fs.readdirSync(cacheRoot)
      .filter((name) => /^chromium-\d+$/.test(name))
      .sort()
      .reverse()
      .forEach((name) => candidates.push(path.join(cacheRoot, name, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing')));
  } catch (_error) { /* 目录不存在时继续用系统 Chrome */ }
  candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  return candidates.find((candidate) => {
    try { return fs.statSync(candidate).isFile(); } catch (_error) { return false; }
  }) || '';
}

(async () => {
  const args = parseArgs(process.argv);
  const result = { ok: false, steps: [] };
  const playwright = loadPlaywright();
  const executablePath = resolveExecutable();
  result.executablePath = executablePath;
  if (!executablePath) {
    result.error = 'no_chromium_executable';
    process.stdout.write(`${JSON.stringify(result, null, 1)}\n`);
    process.exit(1);
  }

  const browser = await playwright.chromium.launch({
    executablePath,
    headless: !args.headful,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  // 管理面 key 走 WebUI 真实读取的那份存储：`aih:control-plane-profiles:v1` 是 profile
  // 数组，WebUI 按 endpoint 与当前 origin 同源匹配后取 managementKey（见
  // web/src/services/webui-auth-transport.ts）。写成别的键名页面读不到，会静默 401。
  await context.addInitScript(({ key, base, argsSession }) => {
    try {
      window.localStorage.setItem('aih:control-plane-profiles:v1', JSON.stringify([{
        id: 'probe-local',
        name: 'Probe Local',
        endpoint: base,
        state: 'ready',
        managementKey: key
      }]));
      window.localStorage.setItem('aih:active-control-plane-profile:v1', 'probe-local');
      // 会话选择：URL 参数优先，但 localStorage 是页面重载/深链恢复的兜底。
      if (argsSession) {
        window.localStorage.setItem('web-chat-selection-v1', JSON.stringify({ sessionId: argsSession }));
      }
      // 工作区模式：chat = 纯聊天（无需工作目录），work = 项目会话。
      window.localStorage.setItem('aih_chat_workspace_mode', 'chat');
    } catch (_error) { /* localStorage 不可用时页面会自行要求登录 */ }
  }, { key: args.key, base: args.base, argsSession: args.session });

  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 200)); });
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${String(error && error.message || error).slice(0, 200)}`));
  // 抓非 2xx 响应的正文：前端把失败折叠成一句 toast，正文里才有可操作的原因。
  const failedResponses = [];
  page.on('response', async (response) => {
    const status = response.status();
    if (status < 400) return;
    let body = '';
    try { body = (await response.text()).slice(0, 400); } catch (_error) { /* 无正文 */ }
    failedResponses.push({ status, url: response.url().slice(0, 160), body });
  });

  const chatUrl = `${args.base}/ui/chat${args.session ? `?sessionId=${encodeURIComponent(args.session)}` : ''}`;
  result.chatUrl = chatUrl;
  await page.goto(chatUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  result.steps.push('page loaded');

  // 等 SPA 挂载：出现输入框即视为就绪（选择器按语义优先级依次尝试）。
  // 等 SPA 挂载并渲染出输入框。用 locator 的 waitFor 而不是手写轮询：
  // 手写轮询在 `locator.first()` 上反复求值会在元素重渲染时拿到陈旧句柄。
  const composerSelectors = [
    'textarea',
    '[contenteditable="true"]',
    'input[type="text"]'
  ];
  let composer = null;
  let composerSelector = '';
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline && !composer) {
    for (const selector of composerSelectors) {
      const candidate = page.locator(selector).first();
      try {
        await candidate.waitFor({ state: 'visible', timeout: 2000 });
        composer = candidate;
        composerSelector = selector;
        break;
      } catch (_error) { /* 试下一个选择器 */ }
    }
    if (!composer) await page.waitForTimeout(300);
  }
  result.composerSelector = composerSelector;
  if (!composer) {
    result.error = 'composer_not_found';
    result.consoleErrors = consoleErrors.slice(0, 10);
    result.failedResponses = failedResponses.slice(0, 10);
    result.tailText = (await page.locator('body').innerText().catch(() => '')).slice(-600);
    if (args.shot) await page.screenshot({ path: args.shot, fullPage: true }).catch(() => {});
    await browser.close();
    process.stdout.write(`${JSON.stringify(result, null, 1)}\n`);
    process.exit(1);
  }
  result.steps.push('composer visible');

  await composer.click();
  await composer.fill(args.prompt).catch(async () => { await composer.type(args.prompt); });
  await page.keyboard.press('Enter');
  result.steps.push('prompt submitted');

  // 等回复出现。
  //
  // 必须去重：用户消息本身就含目标串（prompt 里写的就是它），
  // 只判「页面出现该串」会在回复到来之前就误判为通过（实测踩中：
  // 截图里只有用户消息，但探针报了 ok:true）。
  // 判据改为「标记出现次数 > 用户消息回显次数」—— 回显只会出现一次。
  const marker = args.prompt.replace(/^.*exactly:\s*/i, '').trim() || 'COMPUTER-OK';
  const countOccurrences = (haystack, needle) => {
    if (!needle) return 0;
    let count = 0;
    let index = haystack.indexOf(needle);
    while (index >= 0) { count += 1; index = haystack.indexOf(needle, index + needle.length); }
    return count;
  };
  let sawReply = false;
  let markerCount = 0;
  const replyDeadline = Date.now() + args.timeoutMs;
  while (Date.now() < replyDeadline && !sawReply) {
    const body = await page.locator('body').innerText().catch(() => '');
    markerCount = countOccurrences(body, marker);
    if (markerCount > 1) sawReply = true;
    else await page.waitForTimeout(1000);
  }
  result.markerCount = markerCount;
  result.sawReply = sawReply;
  result.ok = sawReply;
  result.consoleErrors = consoleErrors.slice(0, 10);
  result.failedResponses = failedResponses.slice(0, 10);
  if (args.shot) {
    await page.screenshot({ path: args.shot, fullPage: true }).catch(() => {});
    result.screenshot = args.shot;
  }
  const bodyText = await page.locator('body').innerText().catch(() => '');
  result.tailText = bodyText.slice(-600);

  await browser.close();
  process.stdout.write(`${JSON.stringify(result, null, 1)}\n`);
  process.exit(result.ok ? 0 : 1);
})().catch((error) => {
  process.stdout.write(`${JSON.stringify({ ok: false, error: String(error && error.message || error) }, null, 1)}\n`);
  process.exit(1);
});
