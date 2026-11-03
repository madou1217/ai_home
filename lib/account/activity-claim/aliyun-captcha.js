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
    return await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ ok: false, stage: 'timeout' }), ${sdkTimeout});
      const done = (value) => { clearTimeout(timer); resolve(value); };
      try {
        window.initAliyunCaptcha({
          SceneId: ${JSON.stringify(sceneId)},
          mode: 'popup',
          language: 'cn',
          showErrorTip: false,
          element: '#aih-captcha-host',
          button: '#aih-captcha-button',
          getInstance: (instance) => {
            try {
              instance.startTracelessVerification();
            } catch (error) {
              done({ ok: false, stage: 'instance', error: String(error && error.message || error) });
            }
          },
          success: (param) => done({ ok: true, param: String(param || '') }),
          fail: (error) => done({ ok: false, stage: 'fail', error }),
          onError: (error) => done({ ok: false, stage: 'onError', error })
        });
      } catch (error) {
        done({ ok: false, stage: 'init', error: String(error && error.message || error) });
      }
    });
  })()`;
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
  const userDataDir = fsImpl.mkdtempSync(nodePath.join(os.tmpdir(), 'aih-captcha-'));
  const majorVersion = readChromeMajorVersion(executable);
  const child = spawn(executable, [
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
  try {
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
          document.body.appendChild(host);
          const button = document.createElement('button');
          button.id = 'aih-captcha-button';
          button.textContent = 'verify';
          document.body.appendChild(button);
        }
        return true;
      })()`,
      returnByValue: true
    }, sessionId);

    const evaluated = await cdp.send('Runtime.evaluate', {
      expression: buildCaptchaExpression({ sceneId, prefix, region, timeoutMs }),
      awaitPromise: true,
      returnByValue: true
    }, sessionId);
    if (evaluated && evaluated.exceptionDetails) {
      const detail = evaluated.exceptionDetails.exception
        && evaluated.exceptionDetails.exception.description;
      throw new Error(`captcha_evaluate_failed:${normalizeText(detail) || 'unknown'}`);
    }
    const value = evaluated && evaluated.result ? evaluated.result.value : null;
    if (!value || value.ok !== true || !normalizeText(value.param)) {
      throw new Error(`captcha_failed:${JSON.stringify(value || null).slice(0, 300)}`);
    }
    return normalizeText(value.param);
  } finally {
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
