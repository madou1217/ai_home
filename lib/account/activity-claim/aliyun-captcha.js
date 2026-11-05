'use strict';

// 阿里云验证码 2.0「无痕验证」求解器（零 npm 依赖）。
//
// 为什么需要它：ZCode 的 `POST /api/v1/zcode-plan/billing/claim` 在服务端强制校验
// `X-Aliyun-Captcha-Verify-Param`（空值直接 400 `{"code":3007,"msg":"captcha verify failed"}`），
// 而这个参数只能由阿里云验证码 SDK 在真实浏览器里生成。桌面端用 Electron 渲染层跑
// SDK；这里用本机 Chrome + CDP 复现同一条无痕验证路径。
//
// 事实来源（2026-10-20 真机取证，2026-11-04 复核并推翻部分结论）：
//   * captcha 配置来自 ZCode `/api/v1/client/configs` 的 `configs.captcha`
//     （`{enabled, prefix, region, sceneId}`），不是硬编码；
//   * SDK：https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js
//   * claim 还必须带 `X-Aliyun-Captcha-Verify-Region: <region>`，否则同一个参数仍报 3007。
//
// **2026-11-04 复核：无痕验证已经走不通，必须「有头 + 拟人轨迹」**。
// 当天全部 8 个账号报 zcode_captcha_rejected，逐项对照实验（同一 scene、同一机器）：
//   headless + 程序化点击        → F001 verifyResult:false
//   headless + 拟人轨迹          → F001
//   headed   + 程序化点击        → F001
//   headed   + 拟人轨迹          → success（拿到 captchaVerifyParam，claim 成功）
//   headed   + 拟人轨迹 + 全新 profile → success（profile 无关）
//   无 CDP、纯页面 JS 自动点击    → F001（CDP 本身不是判定依据）
// 也就是说阿里云按「是否真实渲染窗口 + 是否有鼠标移动轨迹」判风险，两个条件缺一不可。
// 因此现在的实现是：有头窗口 + 贝塞尔轨迹移动 + 按压停留后释放。
// 另：验证码参数是**一次性**的，一个 param 只能领一个账号，批量领取必须逐账号解算。
//
// **2026-11-05 真机复核：macOS 上必须用 `open -na` 启动，窗口用 CDP 移出屏幕**。
//   * 直接 spawn `Google Chrome` 二进制时，本机网络扩展（Surge / MonoProxy）会掐掉
//     新进程的出站连接：页面导航 12s / 28s / 130s 不等，甚至永远不 commit。用
//     LaunchServices（`open -na <App>.app --args ...`）启动则 375ms 就能 commit。
//     这既是「验证码窗口长时间挂着」的原因，也是「自动点击来不及」的上游诱因。
//   * `--window-position=-3000,-3000` 在 macOS 上被忽略，窗口仍出现在 (0,31)；
//     CDP `Browser.setWindowBounds({left:-3000})` 会被 clamp 到 left=-860（留 40px
//     在屏内），但控件在 x=80..540，已经整块不可见。移窗要在导航前做（此时还是
//     about:blank，不会影响渲染进程）。
//
// **2026-11-05 真机复核：必须 `--use-mock-keychain`，不能碰系统钥匙串**。
//   本机没有登录钥匙串（`security list-keychains` 只有 System.keychain，
//   `security default-keychain -d user` 报 "A default keychain could not be found"），
//   Chrome 建新 profile 时要存 "Chrome Safe Storage" 却无处可存，弹出
//   「A keychain cannot be found to store "Chrome."」，SecurityAgent 常驻把解算
//   卡到 90s 超时（用户看到的就是「每次都要手动点」）。A/B/A 对照：
//     不带 flag → 每次启动都新起 SecurityAgent；
//     带 flag   → 0 次，端到端 15s 拿到 captchaVerifyParam。
//   mock keychain 只在进程内生成临时密钥，不写系统钥匙串，也不影响页面指纹。


const { spawn, execFileSync } = require('node:child_process');
const nodeFs = require('node:fs');
const os = require('node:os');
const nodePath = require('node:path');

const SDK_URL = 'https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js';
const PAGE_URL = 'https://zcode.z.ai/';
const PAGE_ORIGIN = 'https://zcode.z.ai';
const DEFAULT_TIMEOUT_MS = 60_000;
const DEVTOOLS_TIMEOUT_MS = 20_000;
const PAGE_READY_TIMEOUT_MS = 30_000;
// 页面 readyState=complete 之后再静置的时间（真机对照实验：0ms 会稳定拿到 F001）。
const PAGE_SETTLE_MS = 2_500;
// 交互控件是 init 之后异步渲染的；必须等它出现再取坐标。
// 2026-11-05 事故：init 返回后立刻取坐标，控件还没渲染，代码退化成点宿主中心
// （空白区）→ 点了个寂寞 → 一直等到 deadline → 用户只好手动点。
const WIDGET_TIMEOUT_MS = 10_000;
// 离屏位置。macOS 会 clamp 到 left=-860，但控件在 x=80..540，已经整块在屏幕外。
const OFFSCREEN_LEFT = -3000;
const OFFSCREEN_TOP = -3000;

function normalizeText(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function pathExists(fsImpl, file) {
  try {
    return Boolean(file) && fsImpl.existsSync(file);
  } catch (_error) {
    return false;
  }
}

function findOnPath(fsImpl, names, env) {
  const pathValue = normalizeText(env.PATH || env.Path || '');
  if (!pathValue) return '';
  const separator = process.platform === 'win32' ? ';' : ':';
  for (const dir of pathValue.split(separator)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = nodePath.join(dir, name);
      if (pathExists(fsImpl, candidate)) return candidate;
    }
  }
  return '';
}

/**
 * 找到本机 Chrome / Chromium / Edge 可执行文件。
 * 只做本机探测；不下载、不安装。找不到时抛 captcha_browser_not_found。
 */
function resolveChromeExecutable(options = {}) {
  const fsImpl = options.fs || nodeFs;
  const platform = normalizeText(options.platform) || process.platform;
  const env = options.env || process.env;
  const hostHomeDir = normalizeText(options.hostHomeDir) || os.homedir();
  const explicit = normalizeText(options.executablePath);
  if (explicit) {
    if (pathExists(fsImpl, explicit)) return explicit;
    throw new Error(`captcha_browser_not_found:${explicit}`);
  }
  const candidates = [];
  if (platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      nodePath.join(hostHomeDir, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      nodePath.join(hostHomeDir, 'Applications/Chromium.app/Contents/MacOS/Chromium'),
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
    );
  } else if (platform === 'win32') {
    for (const root of [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA]) {
      const base = normalizeText(root);
      if (!base) continue;
      candidates.push(
        nodePath.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        nodePath.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
      );
    }
  } else {
    candidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium'
    );
  }
  for (const candidate of candidates) {
    if (pathExists(fsImpl, candidate)) return candidate;
  }
  const fromPath = findOnPath(
    fsImpl,
    platform === 'win32'
      ? ['chrome.exe', 'msedge.exe']
      : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge'],
    env
  );
  if (fromPath) return fromPath;
  throw new Error('captcha_browser_not_found: install Google Chrome or pass --captcha-browser <path>');
}

/**
 * 有头 + 尽量离屏。**不要改回 `--headless=new`**：2026-11-04 对照实验里 headless 下
 * 无论点击多拟人都返回 F001，只有真实窗口渲染才给过。
 * `--window-position` 在 Windows/Linux 有效；macOS 会忽略它，由 CDP 在导航前移窗
 * （见 `moveCaptchaWindowOffscreen`）。
 */
function buildCaptchaLaunchArgs(userDataDir) {
  return [
    `--window-position=${OFFSCREEN_LEFT},${OFFSCREEN_TOP}`,
    '--window-size=900,700',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    // **不能用系统钥匙串**：本机没有登录钥匙串（`security list-keychains` 只有
    // System.keychain），Chrome 建 profile 时会弹「A keychain cannot be found to
    // store "Chrome."」，把启动/解算卡死（2026-11-05 真机：SecurityAgent 常驻、
    // 解算 90s 超时）。mock keychain 是 Chromium 官方测试开关，只在进程内生成
    // 临时密钥，不碰系统钥匙串，也不影响页面指纹。
    '--use-mock-keychain',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    'about:blank'
  ];
}

/**
 * 等 Chrome 把调试端口写进 `<user-data-dir>/DevToolsActivePort`。
 *
 * 为什么不用 stderr 里的 "DevTools listening on ..."：macOS 必须用 `open -na` 启动
 * （见 `launchCaptchaBrowser`），拿不到子进程 stderr；而端口文件是 Chrome 自己写的，
 * 两种启动方式都适用，还顺带避开了固定端口的冲突。
 */
async function waitForDevtoolsPort(fsImpl, userDataDir, timeoutMs) {
  const readFile = typeof fsImpl.readFileSync === 'function'
    ? fsImpl.readFileSync.bind(fsImpl)
    : nodeFs.readFileSync;
  const portFile = nodePath.join(userDataDir, 'DevToolsActivePort');
  const deadline = Date.now() + Math.max(1_000, Number(timeoutMs) || DEVTOOLS_TIMEOUT_MS);
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const raw = String(readFile(portFile, 'utf8')).trim().split('\n');
      const port = Number(raw[0]);
      if (Number.isFinite(port) && port > 0) {
        return { port, path: normalizeText(raw[1]) };
      }
    } catch (error) {
      lastError = normalizeText(error && error.code) || 'read_failed';
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`captcha_devtools_timeout:${lastError}`);
}

/** `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` → `/Applications/Google Chrome.app` */
function resolveMacAppBundle(executable) {
  const marker = `${nodePath.sep}Contents${nodePath.sep}MacOS${nodePath.sep}`;
  const index = executable.indexOf(marker);
  return index > 0 ? executable.slice(0, index) : '';
}

/**
 * 启动验证码浏览器。
 *
 * **macOS 必须走 `open -na <App>.app --args ...`，不能直接 spawn 二进制**：
 * 2026-11-05 真机复核，直接 spawn 时本机网络扩展（Surge / MonoProxy）会把新进程的
 * 出站连接掐掉 —— 页面导航 12s / 28s / 130s 不等，甚至永远不 commit；同一台机器上
 * 用 LaunchServices（`open`）启动就正常（example.com 375ms commit）。这既是「验证码
 * 窗口长时间挂着」的原因，也是「自动点击来不及、用户只好手点」的上游诱因。
 * 非 macOS 平台没有这个问题，保持直接 spawn（能拿到 stderr，便于排错）。
 */
function launchCaptchaBrowser({ executable, userDataDir, args, platform, spawnImpl }) {
  if (platform === 'darwin') {
    const bundle = resolveMacAppBundle(executable);
    if (bundle) {
      // `-g`：不要抢前台。窗口会直接出现在后台（配合 CDP 移出屏幕，用户看不到），
      // 实测导航与验证码解算不受影响（`document.hasFocus()===false` 也能过）。
      const child = spawnImpl('open', ['-g', '-na', bundle, '--args', ...args], { stdio: 'ignore' });
      return { child, viaOpen: true };
    }
  }
  const child = spawnImpl(executable, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  return { child, viaOpen: false };
}

/** 杀掉监听调试端口的浏览器进程（`open` 启动时拿不到子进程句柄）。 */
function killBrowserOnPort(port) {
  if (!port) return;
  try {
    const output = execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
    for (const line of String(output).split('\n')) {
      const pid = Number(line.trim());
      if (!Number.isFinite(pid) || pid <= 0) continue;
      try { process.kill(pid, 'SIGKILL'); } catch (_error) { /* 可能已退出 */ }
    }
  } catch (_error) {
    // lsof 没装 / 端口已释放：忽略。
  }
}

function createCdpConnection(wsUrl) {
  if (typeof WebSocket !== 'function') {
    throw new Error('captcha_websocket_unavailable: Node.js >= 22 is required');
  }
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    let message = null;
    try {
      message = JSON.parse(String(event.data));
    } catch (_error) {
      return;
    }
    if (message.id && pending.has(message.id)) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(`${message.error.code}:${message.error.message}`));
      else entry.resolve(message.result);
    }
  });
  const opened = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', () => reject(new Error('captcha_cdp_ws_error')));
  });
  const send = (method, params, sessionId) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({
      id,
      method,
      params: params || {},
      ...(sessionId ? { sessionId } : {})
    }));
  });
  return {
    opened,
    send,
    close: () => {
      try {
        ws.close();
      } catch (_error) {
        // 关闭失败不影响主流程。
      }
    }
  };
}

function buildCaptchaExpression({ sceneId, prefix, region }) {
  return `(async () => {
    window.AliyunCaptchaConfig = { region: ${JSON.stringify(region)}, prefix: ${JSON.stringify(prefix)} };
    window.__aihCaptchaOutcome = null;
    window.__aihCaptchaInstance = null;
    const loadSdk = () => new Promise((resolve, reject) => {
      if (typeof window.initAliyunCaptcha === 'function') return resolve();
      const script = document.createElement('script');
      script.src = ${JSON.stringify(SDK_URL)};
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('captcha_sdk_load_failed'));
      document.head.appendChild(script);
    });
    try {
      await loadSdk();
    } catch (error) {
      return { ok: false, stage: 'sdk', error: String(error && error.message || error) };
    }
    // embed 模式 + 真实尺寸的宿主：popup 模式配 0×0 宿主时控件根本不渲染，
    // SDK 只能退回无痕验证 → 稳定 F001（2026-11-04 截图取证）。
    // getInstance 里把 startTracelessVerification 藏掉，强制走交互式验证，
    // 与桌面端 3.17.x 的 forceInteractive 一致（见 zcode-electron-captcha-hook）。
    try {
      window.initAliyunCaptcha({
        SceneId: ${JSON.stringify(sceneId)},
        mode: 'embed',
        language: 'cn',
        showErrorTip: false,
        element: '#aih-captcha-host',
        getInstance: (instance) => {
          try {
            window.__aihCaptchaInstance = new Proxy(instance, {
              get(target, property) {
                if (property === 'startTracelessVerification') return undefined;
                const value = Reflect.get(target, property, target);
                return typeof value === 'function' ? value.bind(target) : value;
              }
            });
          } catch (_error) {
            window.__aihCaptchaInstance = instance;
          }
        },
        success: (param) => { window.__aihCaptchaOutcome = { ok: true, param: String(param || '') }; },
        fail: (error) => { window.__aihCaptchaOutcome = { ok: false, stage: 'fail', error }; },
        onError: (error) => { window.__aihCaptchaOutcome = { ok: false, stage: 'onError', error }; }
      });
    } catch (error) {
      return { ok: false, stage: 'init', error: String(error && error.message || error) };
    }
    return { ok: false, stage: 'ready' };
  })()`;
}

/**
 * 拟人点击：从右下方的空白处沿贝塞尔缓动移到目标点，途中带抖动，落点后按压停留。
 *
 * 阿里云把「瞬时瞬移点击」判成机器行为（F001），真实移动轨迹才给过。步数、
 * 缓动、抖动幅度、按压 90–150ms 都取自 2026-11-04 跑通的对照实验。
 */
async function dispatchHumanClick(cdp, sessionId, point) {
  const startX = point.x - 320;
  const startY = point.y + 260;
  const steps = 45;
  for (let index = 1; index <= steps; index += 1) {
    const t = index / steps;
    const eased = t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2;
    const jitterX = (Math.random() - 0.5) * 3;
    const jitterY = (Math.random() - 0.5) * 3;
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: startX + (point.x - startX) * eased + jitterX,
      y: startY + (point.y - startY) * eased + jitterY
    }, sessionId);
    await new Promise((resolve) => setTimeout(resolve, 18 + Math.random() * 12));
  }
  await new Promise((resolve) => setTimeout(resolve, 180));
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1
  }, sessionId);
  await new Promise((resolve) => setTimeout(resolve, 90 + Math.random() * 60));
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1
  }, sessionId);
}

// 取「点击开始验证」控件的中心点。**没有控件时必须返回 null**：
// 退化成点宿主中心会点在一片空白上，表现为「自动解算永远超时、只能人工点」。
const CAPTCHA_BUTTON_EXPRESSION = `(() => {
  const host = document.getElementById('aih-captcha-host');
  if (!host) return null;
  const nodes = Array.from(host.querySelectorAll('*')).filter((node) => (
    node.children.length === 0 && /点击|开始验证/.test(node.textContent || '')
  ));
  if (nodes.length === 0) return null;
  const box = nodes[0].getBoundingClientRect();
  if (!(box.width > 0 && box.height > 0)) return null;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
})()`;

/**
 * 等交互控件渲染出来再取坐标。SDK 的 `initAliyunCaptcha` 是同步返回、异步渲染，
 * 真机上 init 返回时宿主里通常还是空的（2026-11-05 实测：立刻取坐标必然 matched=false）。
 */
async function waitForCaptchaButton(cdp, sessionId, timeoutMs) {
  const deadline = Date.now() + Math.max(1_000, Number(timeoutMs) || WIDGET_TIMEOUT_MS);
  while (Date.now() < deadline) {
    const rect = await cdp.send('Runtime.evaluate', {
      expression: CAPTCHA_BUTTON_EXPRESSION,
      returnByValue: true
    }, sessionId);
    const point = rect && rect.result ? rect.result.value : null;
    if (point) return point;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return null;
}

/**
 * 把窗口移到屏幕外。**在导航前调用**（此时页面还是 about:blank，移窗不影响渲染）。
 * 只移动、不最小化 —— 最小化会把 `document.visibilityState` 变成 hidden，
 * 移动后仍是 visible，风控表现最接近真机。
 * macOS 会把 left clamp 到 -860（留 40px 在屏内），但控件在 x=80..540，已经整块不可见。
 * 失败不抛异常 —— 藏不住只是打扰用户，不该让解算失败。
 */
async function moveCaptchaWindowOffscreen(cdp, targetId) {
  try {
    const info = await cdp.send('Browser.getWindowForTarget', { targetId });
    const windowId = info && info.windowId;
    if (!windowId) return false;
    await cdp.send('Browser.setWindowBounds', {
      windowId,
      bounds: { left: OFFSCREEN_LEFT, top: OFFSCREEN_TOP }
    });
    return true;
  } catch (_error) {
    return false;
  }
}

/**
 * 等页面文档真正可用。返回 `{ ready, complete }`：
 *   ready    = 已经是目标 origin 且 body 存在（可以注入控件）
 *   complete = readyState 也到了 complete（风控脚本跑完了）
 * `Page.navigate` 在真机上可能几十秒才回包，所以调用方不等它，只轮询文档状态。
 */
async function waitForDocument(cdp, sessionId, timeoutMs) {
  const deadline = Date.now() + Math.max(1_000, Number(timeoutMs) || PAGE_READY_TIMEOUT_MS);
  let ready = false;
  while (Date.now() < deadline) {
    const state = await cdp.send('Runtime.evaluate', {
      expression: `({ href: String(location.href), origin: String(location.origin), ready: String(document.readyState), hasBody: Boolean(document.body) })`,
      returnByValue: true
    }, sessionId);
    const value = state && state.result ? state.result.value : null;
    if (value && value.origin === PAGE_ORIGIN && value.hasBody) {
      ready = true;
      if (value.ready === 'complete') return { ready: true, complete: true };
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return { ready, complete: false };
}

/**
 * 跑一次交互式验证：init → 等控件渲染 → 拟人鼠标轨迹 → 点击「点击开始验证」→ 等 success。
 *
 * 为什么必须有轨迹：2026-11-04 对照实验里，headless 或瞬时点击都稳定 F001，
 * 只有「真实窗口 + 贝塞尔移动 + 按压停留」才拿到 success。
 */
async function runCaptchaInteraction(cdp, sessionId, input) {
  const init = await cdp.send('Runtime.evaluate', {
    expression: buildCaptchaExpression(input),
    awaitPromise: true,
    returnByValue: true
  }, sessionId);
  if (init && init.exceptionDetails) {
    const detail = init.exceptionDetails.exception
      && init.exceptionDetails.exception.description;
    throw new Error(`captcha_evaluate_failed:${normalizeText(detail) || 'unknown'}`);
  }
  const ready = init && init.result ? init.result.value : null;
  if (!ready || ready.stage !== 'ready') {
    throw new Error(`captcha_failed:${JSON.stringify(ready || null).slice(0, 300)}`);
  }
  // 控件是异步渲染的：必须等它出现，绝不能退回点宿主中心。
  const point = await waitForCaptchaButton(cdp, sessionId, input.widgetTimeoutMs);
  if (!point) throw new Error('captcha_failed:{"ok":false,"stage":"button_missing"}');
  // 控件已渲染，此时藏窗是安全的（文档早已加载完成）。
  if (typeof input.beforeClick === 'function') {
    await input.beforeClick();
  }
  await dispatchHumanClick(cdp, sessionId, point);
  const remainingMs = Math.max(5_000, Number(input.remainingMs) || 45_000);
  const outcome = await cdp.send('Runtime.evaluate', {
    expression: `(async () => {
      const deadline = Date.now() + ${remainingMs};
      while (Date.now() < deadline) {
        if (window.__aihCaptchaOutcome) return window.__aihCaptchaOutcome;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      return { ok: false, stage: 'timeout' };
    })()`,
    awaitPromise: true,
    returnByValue: true
  }, sessionId);
  const value = outcome && outcome.result ? outcome.result.value : null;
  if (!value || value.ok !== true || !normalizeText(value.param)) {
    throw new Error(`captcha_failed:${JSON.stringify(value || null).slice(0, 300)}`);
  }
  return normalizeText(value.param);
}

/**
 * 跑一次无痕验证，返回 captchaVerifyParam。
 * 任何失败都抛异常（错误码前缀 captcha_*），由调用方决定是否继续 claim。
 */
async function solveAliyunCaptcha(options = {}) {
  const sceneId = normalizeText(options.sceneId);
  const prefix = normalizeText(options.prefix);
  const region = normalizeText(options.region) || 'cn';
  const timeoutMs = Math.max(10_000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS);
  if (!sceneId || !prefix) throw new Error('captcha_config_missing:sceneId/prefix');

  const executable = resolveChromeExecutable(options);
  const fsImpl = options.fs || nodeFs;
  const spawnImpl = typeof options.spawnImpl === 'function' ? options.spawnImpl : spawn;
  const platform = normalizeText(options.platform) || process.platform;
  const userDataDir = fsImpl.mkdtempSync(nodePath.join(os.tmpdir(), 'aih-captcha-'));
  const launched = launchCaptchaBrowser({
    executable,
    userDataDir,
    args: buildCaptchaLaunchArgs(userDataDir),
    platform,
    spawnImpl
  });
  const child = launched.child;

  let cdp = null;
  let devtoolsPort = 0;
  // **硬截止时间**：CDP 的 send / Runtime.evaluate 没有内建超时。浏览器一旦卡死
  // （渲染进程挂起、页面定时器不跑），整条领取链会永远等下去 —— 计划任务因此
  // 撞到 30 分钟 task_timeout（2026-11-03 真机）。deadline 到点先杀浏览器再抛
  // captcha_timeout，保证单次解算有上界，批量任务不会因为一个账号停摆。
  const deadlineMs = Math.max(1_000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS);
  const deadlineAt = Date.now() + deadlineMs;
  const remainingMs = () => Math.max(0, deadlineAt - Date.now());
  let deadlineTimer = null;
  const flow = (async () => {
    const devtools = await waitForDevtoolsPort(
      fsImpl,
      userDataDir,
      Math.min(DEVTOOLS_TIMEOUT_MS, timeoutMs)
    );
    devtoolsPort = devtools.port;
    const wsUrl = `ws://127.0.0.1:${devtools.port}${devtools.path}`;
    cdp = createCdpConnection(wsUrl);
    await cdp.opened;
    // 直接复用启动时那个 about:blank 页签：另开 target 会再弹一个窗口。
    const targets = await cdp.send('Target.getTargets');
    const page = (targets && Array.isArray(targets.targetInfos) ? targets.targetInfos : [])
      .find((info) => info && info.type === 'page');
    if (!page) throw new Error('captcha_failed:{"ok":false,"stage":"target_missing"}');
    const attached = await cdp.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
    const sessionId = attached && attached.sessionId;
    if (!sessionId) throw new Error('captcha_failed:{"ok":false,"stage":"attach_failed"}');
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    // 窗口先移出屏幕再导航：此时页面还是 about:blank，移窗不会影响渲染进程。
    // （2026-11-05 复核：之前观察到的「移窗/最小化后渲染进程冻结」其实是直接 spawn
    //   导致的网络阻塞，换成 open 启动后，先移窗再导航完全正常。）
    await moveCaptchaWindowOffscreen(cdp, page.targetId);
    // 有头窗口本身就是真实浏览器指纹：不要伪造 UA / 视口 / 时区 / navigator.webdriver。
    // 2026-11-04 实测：加上 webdriver 覆盖与时区覆盖后，同样有头、同样拟人轨迹仍返回 F001。
    //
    // **不要 await Page.navigate**：真机上它可能几十秒才回包（实测 12s/28s/130s），
    // 期间文档其实已经在加载。这里只轮询文档状态。
    cdp.send('Page.navigate', { url: PAGE_URL }, sessionId).catch(() => {});

    const pageReadyMs = Math.min(PAGE_READY_TIMEOUT_MS, Math.max(5_000, remainingMs() - 20_000));
    const documentState = await waitForDocument(cdp, sessionId, pageReadyMs);
    if (!documentState.ready) {
      throw new Error('captcha_failed:{"ok":false,"stage":"page_not_ready"}');
    }
    // readyState=complete 只代表文档加载完，站点的风控脚本与 SDK 依赖的上下文
    // 还要再跑一会儿；不等这一下，无痕验证会返回 F001 verifyResult:false。
    await new Promise((resolve) => setTimeout(resolve, PAGE_SETTLE_MS));

    // embed 模式会往 host 里渲染控件，host 必须有真实尺寸——0×0 时控件不渲染，
    // SDK 只能退回无痕验证并返回 F001（2026-11-04 截图取证）。
    await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        if (!document.getElementById('aih-captcha-host')) {
          const wrap = document.createElement('div');
          wrap.style.cssText = 'position:fixed;top:80px;left:80px;width:460px;padding:12px;background:#fff;border:2px solid #e5e7eb;border-radius:8px;z-index:2147483647;';
          const host = document.createElement('div');
          host.id = 'aih-captcha-host';
          host.style.cssText = 'min-height:420px;';
          wrap.appendChild(host);
          document.body.appendChild(wrap);
        }
        return true;
      })()`,
      returnByValue: true
    }, sessionId);

    return await runCaptchaInteraction(cdp, sessionId, {
      sceneId,
      prefix,
      region,
      widgetTimeoutMs: Math.min(WIDGET_TIMEOUT_MS, Math.max(2_000, remainingMs() - 10_000)),
      remainingMs: Math.max(5_000, remainingMs() - 1_000),
      beforeClick: () => moveCaptchaWindowOffscreen(cdp, page.targetId)
    });
  })();
  const deadline = new Promise((_resolve, reject) => {
    deadlineTimer = setTimeout(() => {
      try { if (cdp) cdp.close(); } catch (_error) { /* 忽略 */ }
      killBrowserOnPort(devtoolsPort);
      try { child.kill('SIGKILL'); } catch (_error) { /* 进程可能已经退出 */ }
      reject(new Error(`captcha_timeout:${deadlineMs}`));
    }, deadlineMs);
  });
  try {
    return await Promise.race([flow, deadline]);
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    // 先让浏览器自己退出（`open` 启动时没有子进程句柄），再按端口兜底杀进程。
    try {
      if (cdp) await Promise.race([cdp.send('Browser.close'), new Promise((resolve) => setTimeout(resolve, 1_000))]);
    } catch (_error) {
      // 连接已断 / 浏览器已退出。
    }
    if (cdp) cdp.close();
    killBrowserOnPort(devtoolsPort);
    try {
      child.kill('SIGKILL');
    } catch (_error) {
      // 进程可能已经退出。
    }
    try {
      fsImpl.rmSync(userDataDir, { recursive: true, force: true });
    } catch (_error) {
      // 临时目录清理失败不覆盖主错误。
    }
  }
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  resolveChromeExecutable,
  solveAliyunCaptcha,
  __private: {
    CAPTCHA_BUTTON_EXPRESSION,
    buildCaptchaExpression,
    buildCaptchaLaunchArgs,
    dispatchHumanClick,
    launchCaptchaBrowser,
    moveCaptchaWindowOffscreen,
    resolveMacAppBundle,
    waitForCaptchaButton,
    waitForDevtoolsPort,
    waitForDocument
  }
};
