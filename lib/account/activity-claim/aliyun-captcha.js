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
//
// **2026-11-05 真机复核：无感打开（不闪窗、不抢前台）**。
//   * 带窗口启动会先在屏幕中间闪一下：macOS 忽略 `--window-position`，Chrome 的
//     最小窗口是 500×375，从启动到我们接管至少 0.5–1s；某些情况下还会把 Chrome
//     顶到前台，抢走用户正在打字的焦点。
//   * 改成 `--no-startup-window` 启动（完全没有窗口），由 CDP `Target.createTarget`
//     建窗、建完立刻移出屏幕。真机实测建窗前后前台应用不变，窗口排在其他窗口后面。
//   * 窗口**不能**靠 minimize 隐藏：最小化会停掉渲染，解算直接 90s 超时。
//   * 也**不能**靠 headless：Chrome 156 上 `--headless=new` 仍然稳定 F001。
//   * `Browser.setWindowBounds` 的 clamp 规则是「至少留 40px 可见」
//     （left = -(width-40)），改尺寸会重新 clamp，所以窗口永远会留一条 40px 的边；
//     把窗口建在后台 + 立刻移走，这条边通常被前台应用挡住。
//   * Chrome 会为这个临时实例多出一个 Dock 图标（无法从外部去掉，除非改 bundle 的
//     LSUIElement；symlink 包装 App 无效，进程仍归属 Chrome.app）。


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
// 解算冷却：上一次解算**结束后**到下一次开始之间至少静默这么久。
// 2026-11-05 实测（同一机器、同一 scene，连续解算）：
//   0s 间隔  → 3 次里 1 次 F001
//   12s 间隔 → 3 次里 1 次 F001
// 也就是说冷却**不是** F001 的解药（它是概率性的风控判定，12s 照样中）；冷却只保证
// 「快速失败」（F001 三五秒就回、devtools 起不来更是一秒内）之后不会连珠炮式重试。
// 真正的兜底是下面的 F001 退避重试。
const SOLVE_MIN_INTERVAL_MS = 5_000;
// F001（verifyResult:false）退避重试：实测 F001 后停 20s 再解可以过。
// 每次重试都是一整轮浏览器解算（~15s），所以只给两次机会，且受总预算约束。
const F001_RETRY_DELAYS_MS = [20_000, 40_000];
// 决定「还要不要再解一轮」的预算（不改变单轮自己的 timeoutMs）。
// 防止一个账号把批量任务拖到 task_timeout：预算不够就不再重试，直接抛出最后一次错误。
const SOLVE_RETRY_BUDGET_MS = 180_000;

function normalizeText(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 解算闸门：串行 + 最小静默间隔。
//
// 为什么串行：两个解算同时跑会同时拉起两个 Chrome，既抢 CPU 又让两次解算的
// 时间戳挨在一起，正是风控最敏感的特征；批量领取本来就是串行的，不该因为
// 「请求验证头」那条旁路突然插进来变成并发。
let lastSolveEndedAt = 0;
let solveQueue = Promise.resolve();

/**
 * 在闸门内跑一次解算。`options.minIntervalMs` 传 0 可以跳过冷却（测试用）。
 */
async function withSolveGate(options, task) {
  const minIntervalMs = options && options.minIntervalMs !== undefined
    ? Math.max(0, Number(options.minIntervalMs) || 0)
    : SOLVE_MIN_INTERVAL_MS;
  const sleep = options && typeof options.sleep === 'function' ? options.sleep : defaultSleep;
  const now = options && typeof options.now === 'function' ? options.now : Date.now;
  const previous = solveQueue;
  let release;
  solveQueue = new Promise((resolve) => { release = resolve; });
  try {
    await previous.catch(() => {});
    const waitMs = Math.max(0, lastSolveEndedAt + minIntervalMs - now());
    if (waitMs > 0) await sleep(waitMs);
    return await task();
  } finally {
    lastSolveEndedAt = now();
    release();
  }
}

/** F001 = 阿里云判定「疑似机器」。错误消息里带 verifyCode 或裸 F001 都算。 */
function isF001Error(error) {
  return /F001/.test(normalizeText(error && error.message));
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
    // **不建启动窗口**：macOS 上 `--window-position` 被忽略，带窗口启动会先在
    // 屏幕中央闪一下（Chrome 最小窗口 500×375，实测约 0.5–1s），而且可能把
    // Chrome 顶到前台。改成无窗口启动，由 CDP `Target.createTarget` 在后台建窗，
    // 建完立刻移出屏幕（见 solveAliyunCaptchaOnce）。
    '--no-startup-window'
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
 * 拿到（必要时创建）解算用的页面 target。
 *
 * 启动参数是 `--no-startup-window`，所以正常情况下没有现成页签。建窗时**不要**带
 * `background: true`：实测那样页面会被当成后台页，连续两次解算都是 F001；
 * 去掉之后 `document.visibilityState` 是 visible。抢前台的问题由
 * `--no-startup-window` + `open -g` 解决，不需要 background 参数。
 */
async function ensurePageTarget(cdp) {
  const targets = await cdp.send('Target.getTargets');
  const existing = (targets && Array.isArray(targets.targetInfos) ? targets.targetInfos : [])
    .find((info) => info && info.type === 'page');
  if (existing) return existing;
  const created = await cdp.send('Target.createTarget', { url: 'about:blank', newWindow: true });
  if (!created || !created.targetId) {
    throw new Error('captcha_failed:{"ok":false,"stage":"target_missing"}');
  }
  return { targetId: created.targetId };
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
 *
 * 所有调用方都要经过这里（领取与「请求验证头」旁路共用同一个风控预算），
 * 所以冷却闸门放在这一层；F001 退避见 `solveAliyunCaptchaWithRetry`。
 */
async function solveAliyunCaptcha(options = {}) {
  const sceneId = normalizeText(options.sceneId);
  const prefix = normalizeText(options.prefix);
  if (!sceneId || !prefix) throw new Error('captcha_config_missing:sceneId/prefix');
  return withSolveGate(options, () => solveAliyunCaptchaOnce(options));
}

/**
 * F001 退避重试。只重试 F001 —— 超时、找不到浏览器、页面没加载起来都是本地故障，
 * 立刻再来一遍大概率还是同样的错，白烧一次风控额度。
 *
 * `retryDelaysMs` 可以覆盖退避序列（传 [] 关闭重试）；`retryBudgetMs` 是总预算，
 * 预算不够再跑一轮就不再重试，避免单个账号把批量任务拖过 task_timeout。
 */
async function solveAliyunCaptchaWithRetry(options = {}) {
  return runWithF001Retry(() => solveAliyunCaptcha(options), {
    delays: Array.isArray(options.retryDelaysMs) ? options.retryDelaysMs : F001_RETRY_DELAYS_MS,
    budgetMs: options.retryBudgetMs,
    sleep: options.sleep,
    now: options.now
  });
}

/**
 * F001 退避重试的策略本体（与浏览器解耦，便于单测）。
 * `attemptFn` 抛出的错误里带 F001 才重试，其余错误原样抛出。
 */
async function runWithF001Retry(attemptFn, options = {}) {
  const delays = Array.isArray(options.delays) ? options.delays : F001_RETRY_DELAYS_MS;
  const budgetMs = options.budgetMs === undefined
    ? SOLVE_RETRY_BUDGET_MS
    : Math.max(0, Number(options.budgetMs) || 0);
  const sleep = typeof options.sleep === 'function' ? options.sleep : defaultSleep;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const deadlineAt = now() + budgetMs;
  let attempt = 0;
  for (;;) {
    try {
      return await attemptFn(attempt);
    } catch (error) {
      if (attempt >= delays.length || !isF001Error(error)) throw error;
      const delayMs = Math.max(0, Number(delays[attempt]) || 0);
      attempt += 1;
      // 退避完还要留出一次完整解算的时间（按一次正常解算 ~15s 估）。
      if (now() + delayMs + 15_000 > deadlineAt) throw error;
      if (delayMs > 0) await sleep(delayMs);
    }
  }
}

async function solveAliyunCaptchaOnce(options = {}) {
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
    // Chrome 用 `--no-startup-window` 启动，这里没有现成页签，需要自己建。
    const page = await ensurePageTarget(cdp);
    // 窗口先移出屏幕，再做 attach/enable —— 窗口每多露一帧都是干扰。
    // （2026-11-05 复核：之前观察到的「移窗/最小化后渲染进程冻结」其实是直接 spawn
    //   导致的网络阻塞，换成 open 启动后，先移窗再导航完全正常。最小化仍然不行：
    //   最小化会让渲染停止，解算直接 90s 超时。）
    await moveCaptchaWindowOffscreen(cdp, page.targetId);
    const attached = await cdp.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
    const sessionId = attached && attached.sessionId;
    if (!sessionId) throw new Error('captcha_failed:{"ok":false,"stage":"attach_failed"}');
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
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
  F001_RETRY_DELAYS_MS,
  SOLVE_MIN_INTERVAL_MS,
  SOLVE_RETRY_BUDGET_MS,
  resolveChromeExecutable,
  solveAliyunCaptcha,
  solveAliyunCaptchaWithRetry,
  __private: {
    CAPTCHA_BUTTON_EXPRESSION,
    buildCaptchaExpression,
    buildCaptchaLaunchArgs,
    dispatchHumanClick,
    ensurePageTarget,
    isF001Error,
    launchCaptchaBrowser,
    moveCaptchaWindowOffscreen,
    resetSolveGate,
    resolveMacAppBundle,
    runWithF001Retry,
    withSolveGate,
    waitForCaptchaButton,
    waitForDevtoolsPort,
    waitForDocument
  }
};

/** 清掉冷却状态（测试用：同一进程里多个用例互不影响）。 */
function resetSolveGate() {
  lastSolveEndedAt = 0;
  solveQueue = Promise.resolve();
}
