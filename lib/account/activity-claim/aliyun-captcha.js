'use strict';

// 阿里云验证码 2.0「无痕验证」求解器（零 npm 依赖）。
//
// 为什么需要它：ZCode 的 `POST /api/v1/zcode-plan/billing/claim` 在服务端强制校验
// `X-Aliyun-Captcha-Verify-Param`（空值直接 400 `{"code":3007,"msg":"captcha verify failed"}`），
// 而这个参数只能由阿里云验证码 SDK 在真实浏览器里生成。桌面端用 Electron 渲染层跑
// SDK；这里用本机 Chrome + CDP 复现同一条无痕验证路径。
//
// 事实来源（2026-10-20 真机取证）：
//   * captcha 配置来自 ZCode `/api/v1/client/configs` 的 `configs.captcha`
//     （`{enabled, prefix, region, sceneId}`），不是硬编码；
//   * SDK：https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js
//   * `instance.startTracelessVerification()` 在普通 Chrome（headless=new）里可直接
//     返回 280 字符的 captchaVerifyParam，无需人工滑动；
//   * claim 还必须带 `X-Aliyun-Captcha-Verify-Region: <region>`，否则同一个参数仍报 3007。

const { spawn, spawnSync } = require('node:child_process');
const nodeFs = require('node:fs');
const os = require('node:os');
const nodePath = require('node:path');

const SDK_URL = 'https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js';
const PAGE_URL = 'https://zcode.z.ai/';
const DEFAULT_TIMEOUT_MS = 60_000;
const DEVTOOLS_TIMEOUT_MS = 20_000;
const PAGE_READY_TIMEOUT_MS = 10_000;
// 页面 readyState=complete 之后再静置的时间（真机对照实验：0ms 会稳定拿到 F001）。
const PAGE_SETTLE_MS = 2_500;

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

function readChromeMajorVersion(executable) {
  try {
    const result = spawnSync(executable, ['--version'], { encoding: 'utf8', timeout: 5_000 });
    const match = /(\d+)\.\d+\.\d+/.exec(String(result.stdout || result.stderr || ''));
    if (match) return match[1];
  } catch (_error) {
    // 版本只影响 UA 形状；探测失败时用保守值。
  }
  return '131';
}

function waitForDevtoolsUrl(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      finish(reject, new Error(`captcha_devtools_timeout:${buffer.slice(-300)}`));
    }, timeoutMs);
    child.stderr.on('data', (chunk) => {
      buffer += String(chunk);
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(buffer);
      if (match) finish(resolve, match[1]);
    });
    child.on('error', (error) => finish(reject, error));
    child.on('exit', (code) => {
      finish(reject, new Error(`captcha_browser_exited:${code}:${buffer.slice(-300)}`));
    });
  });
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

function buildCaptchaExpression({ sceneId, prefix, region, timeoutMs }) {
  const sdkTimeout = Math.max(5_000, Number(timeoutMs) - 15_000);
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
    // **交互式（按钮点击）优先**：阿里云已对部分账号/环境把无痕验证判成 F001
    // （verifyResult:false），而桌面端从 3.17.x 起也把 startTracelessVerification
    // 藏起来、改走原生 button-click（见 zcode-electron-captcha-hook 的 forceInteractive）。
    // 这里复刻同一条路径：init → 点按钮 → success 回调给 captchaVerifyParam。
    // 8 秒仍未出结果时回退无痕验证，兼容旧 SDK 行为。
    try {
      window.initAliyunCaptcha({
        SceneId: ${JSON.stringify(sceneId)},
        mode: 'popup',
        language: 'cn',
        showErrorTip: false,
        element: '#aih-captcha-host',
        button: '#aih-captcha-button',
        getInstance: (instance) => { window.__aihCaptchaInstance = instance; },
        success: (param) => { window.__aihCaptchaOutcome = { ok: true, param: String(param || '') }; },
        fail: (error) => { window.__aihCaptchaOutcome = { ok: false, stage: 'fail', error }; },
        onError: (error) => { window.__aihCaptchaOutcome = { ok: false, stage: 'onError', error }; }
      });
    } catch (error) {
      return { ok: false, stage: 'init', error: String(error && error.message || error) };
    }
    setTimeout(() => {
      try {
        const instance = window.__aihCaptchaInstance;
        if (!window.__aihCaptchaOutcome && instance && typeof instance.startTracelessVerification === 'function') {
          instance.startTracelessVerification();
        }
      } catch (_error) { /* 回退失败按超时处理 */ }
    }, Math.min(8000, ${sdkTimeout}));
    return { ok: false, stage: 'ready' };
  })()`;
}

/**
 * 在页面里跑一次交互式验证：init → 可信点击按钮 → 等 success 回调。
 *
 * 为什么不是 startTracelessVerification：无痕验证在部分账号/环境稳定返回
 * F001（verifyResult:false），而桌面端 3.17.x 也已改为按钮点击分支。
 * 点击用 CDP Input 事件（可信），element.click() 在部分 SDK 版本会被忽略。
 */
async function runCaptchaInteraction(cdp, sessionId, input) {
  const sdkTimeout = Math.max(5_000, Number(input.timeoutMs) - 15_000);
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
  const rect = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const button = document.getElementById('aih-captcha-button');
      if (!button) return null;
      const box = button.getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    })()`,
    returnByValue: true
  }, sessionId);
  const point = rect && rect.result ? rect.result.value : null;
  if (!point) throw new Error('captcha_failed:{"ok":false,"stage":"button_missing"}');
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y }, sessionId);
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1
  }, sessionId);
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1
  }, sessionId);
  const outcome = await cdp.send('Runtime.evaluate', {
    expression: `(async () => {
      const deadline = Date.now() + ${sdkTimeout};
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
  const userDataDir = fsImpl.mkdtempSync(nodePath.join(os.tmpdir(), 'aih-captcha-'));
  const majorVersion = readChromeMajorVersion(executable);
  const child = spawnImpl(executable, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    'about:blank'
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  let cdp = null;
  // **硬截止时间**：CDP 的 send / Runtime.evaluate 没有内建超时。浏览器一旦卡死
  // （渲染进程挂起、页面定时器不跑），整条领取链会永远等下去 —— 计划任务因此
  // 撞到 30 分钟 task_timeout（2026-11-03 真机）。deadline 到点先杀浏览器再抛
  // captcha_timeout，保证单次解算有上界，批量任务不会因为一个账号停摆。
  const deadlineMs = Math.max(1_000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS);
  let deadlineTimer = null;
  const flow = (async () => {
    const wsUrl = await waitForDevtoolsUrl(child, Math.min(DEVTOOLS_TIMEOUT_MS, timeoutMs));
    cdp = createCdpConnection(wsUrl);
    await cdp.opened;
    const target = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const attached = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    const sessionId = attached.sessionId;
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Emulation.setUserAgentOverride', {
      userAgent: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${majorVersion}.0.0.0 Safari/537.36`,
      acceptLanguage: 'zh-CN,zh;q=0.9,en;q=0.8',
      platform: 'MacIntel'
    }, sessionId);
    await cdp.send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Shanghai' }, sessionId);
    await cdp.send('Emulation.setLocaleOverride', { locale: 'zh-CN' }, sessionId);
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1280,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false
    }, sessionId);
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: 'Object.defineProperty(navigator,"webdriver",{get:()=>undefined});'
    }, sessionId);
    await cdp.send('Page.navigate', { url: PAGE_URL }, sessionId);

    const pageReadyDeadline = Date.now() + PAGE_READY_TIMEOUT_MS;
    while (Date.now() < pageReadyDeadline) {
      const ready = await cdp.send('Runtime.evaluate', {
        expression: 'String(document.readyState)',
        returnByValue: true
      }, sessionId);
      if (ready && ready.result && ready.result.value === 'complete') break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    // readyState=complete 只代表文档加载完，站点的风控脚本与 SDK 依赖的上下文
    // 还要再跑一会儿；不等这一下，无痕验证会返回 F001 verifyResult:false。
    await new Promise((resolve) => setTimeout(resolve, PAGE_SETTLE_MS));

    // SDK 会查询 element/button 节点；在 init 前挂载，避免 "element not found"。
    await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        if (!document.getElementById('aih-captcha-host')) {
          const host = document.createElement('div');
          host.id = 'aih-captcha-host';
          // 弹窗模式会往 host 里渲染；host 不能挡住按钮点击。
          host.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483646;';
          document.body.appendChild(host);
          const button = document.createElement('button');
          button.id = 'aih-captcha-button';
          button.textContent = 'verify';
          // **必须真实可见可点**：交互式验证靠按钮 click 触发，零尺寸/被遮挡会让
          // CDP 的可信点击落到页面别的元素上，SDK 收不到 click，最终回退无痕
          // 验证拿到 F001（2026-11-03 真机：同一配置在带样式的实验页一次就过）。
          button.style.cssText = 'position:fixed;top:40px;left:40px;width:200px;height:60px;z-index:2147483647;';
          document.body.appendChild(button);
        }
        return true;
      })()`,
      returnByValue: true
    }, sessionId);

    return await runCaptchaInteraction(cdp, sessionId, { sceneId, prefix, region, timeoutMs });
  })();
  const deadline = new Promise((_resolve, reject) => {
    deadlineTimer = setTimeout(() => {
      try { if (cdp) cdp.close(); } catch (_error) { /* 忽略 */ }
      try { child.kill('SIGKILL'); } catch (_error) { /* 进程可能已经退出 */ }
      reject(new Error(`captcha_timeout:${deadlineMs}`));
    }, deadlineMs);
  });
  try {
    return await Promise.race([flow, deadline]);
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    if (cdp) cdp.close();
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
  solveAliyunCaptcha
};
