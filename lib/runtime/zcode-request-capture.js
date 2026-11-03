'use strict';

// ZCode 官方客户端的**出站请求取证**（诊断专用，默认关闭，纯旁路）。
//
// 为什么需要：relay 与官方客户端打到同一个 plan 端点，头字段已逐项对齐（device mid
// 取的就是桌面端 telemetry-state.json 的真值、HTTP-Referer / X-ZCode-App-Version /
// X-Platform / X-Client-Language / X-Client-Timezone / X-Title / X-Release-Channel /
// UA 全部一致），但上游对我们的请求回
//   HTTP 405 {"code":3012,"msg":"request has been blocked due to unusual activity."}
// 而官方客户端同一账号、同一时刻正常出答案（桌面端自己的 CLI 日志 4 天里 3012 为 0）。
// 要判定差异只能落在**官方客户端自己发出的字节**上（body 结构 / 头顺序 / 会话头形态），
// 因此这里在 agent 进程里包一层 `globalThis.fetch` 取证。
//
// 开关（不新增环境变量，两级）：`<aiHomeDir>/run/zcode-request-capture.json` 存在即开启，
// 可选 `{ "logPath": "<绝对路径>" }`（缺省 `<aiHomeDir>/run/zcode-requests.jsonl`）。
// 桌面策略读该标记文件 → 写进既有 `AIH_ZCODE_CONTEXT` 的 `requestLog` 字段 →
// `zcode-session-attribution-runner` 在编译 agent 之前安装钩子。
//
// 纪律：纯旁路（任何异常只吞掉，绝不改变/阻断请求）；body 截断；凭据类头只记长度不记明文。

const DEFAULT_MARKER_NAME = 'zcode-request-capture.json';
const DEFAULT_LOG_NAME = 'zcode-requests.jsonl';
const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;
const RESPONSE_PREVIEW_BYTES = 2048;
// 学习官方 harness（产品用途，非诊断）：见 lib/server/zcode-harness-store.js。
const {
  extractZcodeHarnessFromRequestBody,
  writeZcodeHarnessSystem
} = require('../server/zcode-harness-store');
// 学习失败只报一次（按客户端版本去重），避免每个请求刷屏。
const learnMissWarned = new Set();
const REDACTED_HEADERS = new Set([
  'authorization',
  'x-api-key',
  'cookie',
  'proxy-authorization',
  'set-cookie'
]);

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 读标记文件，返回取证日志的绝对路径（'' = 未开启）。
 *
 * @param {object} input { fs, path, aiHomeDir }
 * @returns {string}
 */
function resolveZcodeRequestCaptureLogPath(input = {}) {
  const fsImpl = input.fs || require('node:fs');
  const pathImpl = input.path || require('node:path');
  const aiHomeDir = normalizeText(input.aiHomeDir);
  if (!aiHomeDir || typeof fsImpl.existsSync !== 'function') return '';
  const markerPath = pathImpl.join(aiHomeDir, 'run', DEFAULT_MARKER_NAME);
  try {
    if (!fsImpl.existsSync(markerPath)) return '';
  } catch (_error) {
    return '';
  }
  let configured = '';
  try {
    const parsed = JSON.parse(fsImpl.readFileSync(markerPath, 'utf8'));
    configured = normalizeText(parsed && parsed.logPath);
  } catch (_error) {
    configured = '';
  }
  return configured || pathImpl.join(aiHomeDir, 'run', DEFAULT_LOG_NAME);
}

function headersToObject(headers) {
  const out = {};
  if (!headers) return out;
  try {
    if (typeof headers.forEach === 'function' && typeof headers.get === 'function') {
      headers.forEach((value, name) => { out[String(name).toLowerCase()] = String(value); });
      return out;
    }
    if (Array.isArray(headers)) {
      for (const pair of headers) {
        if (Array.isArray(pair) && pair.length >= 2) out[String(pair[0]).toLowerCase()] = String(pair[1]);
      }
      return out;
    }
    if (typeof headers === 'object') {
      for (const [name, value] of Object.entries(headers)) out[String(name).toLowerCase()] = String(value);
    }
  } catch (_error) { /* 忽略：取证失败不影响请求 */ }
  return out;
}

function redactHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name] = REDACTED_HEADERS.has(name) ? `<redacted len=${String(value).length}>` : value;
  }
  return out;
}

function truncateBody(text, maxBytes) {
  const value = typeof text === 'string' ? text : '';
  if (value.length <= maxBytes) return { body: value, truncated: false };
  return { body: value.slice(0, maxBytes), truncated: true };
}

async function describeRequest(input, init, maxBodyBytes) {
  const record = { at: new Date().toISOString(), pid: process.pid, kind: 'request' };
  let url = '';
  let method = 'GET';
  let headers = {};
  let bodyText = '';
  if (input && typeof input === 'object' && typeof input.clone === 'function' && typeof input.url === 'string') {
    url = input.url;
    method = normalizeText(input.method) || 'GET';
    headers = headersToObject(input.headers);
    try {
      bodyText = await input.clone().text();
    } catch (_error) { /* 流式 body 不可克隆：只留头 */ }
  } else {
    url = typeof input === 'string' ? input : normalizeText(input && input.url);
    if (init && typeof init === 'object') {
      method = normalizeText(init.method) || method;
      headers = headersToObject(init.headers);
      bodyText = typeof init.body === 'string' ? init.body : '';
    }
  }
  record.url = url;
  record.method = method;
  record.headers = redactHeaders(headers);
  const truncated = truncateBody(bodyText, maxBodyBytes);
  record.body = truncated.body;
  if (truncated.truncated) record.bodyTruncated = true;
  return record;
}

/**
 * 安装出站请求取证（幂等、fail-soft）。
 *
 * @param {object} options { fs, logPath, maxBodyBytes, globalObj }
 * @returns {boolean} 是否已安装
 */
function installZcodeRequestCapture(options = {}) {
  const fsImpl = options.fs || require('node:fs');
  const logPath = normalizeText(options.logPath);
  const harnessStorePath = normalizeText(options.harnessStorePath);
  const globalObj = options.globalObj || globalThis;
  if (!logPath && !harnessStorePath) return false;
  const original = globalObj.fetch;
  if (typeof original !== 'function') return false;
  if (original.__aihZcodeRequestCapture === true) return true;
  const maxBodyBytes = Number(options.maxBodyBytes) > 0
    ? Math.floor(Number(options.maxBodyBytes))
    : DEFAULT_MAX_BODY_BYTES;
  const append = (record) => {
    try {
      fsImpl.appendFileSync(logPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    } catch (_error) { /* 取证失败不影响请求 */ }
  };
  // 学习官方 harness：plan 端点的出站请求体里带着官方 system，原样缓存供 relay 复用
  // （见 lib/server/zcode-harness-store.js 的「为什么不 vendored」）。
  const learnHarness = (record) => {
    const url = record && record.url;
    const body = record && record.body;
    if (!harnessStorePath || !body) return;
    if (!String(url || '').includes('zcode-plan/')) return;
    // 版本以**请求头里的真值**为准（`x-zcode-app-version`），而不是启动时的配置：
    // 桌面端自更新后进程内配置可能落后一版，学到的版本号要能代表这份 harness 是谁发的。
    const headerVersion = normalizeText(record.headers && record.headers['x-zcode-app-version']);
    const learnedAppVersion = headerVersion || normalizeText(options.appVersion);
    try {
      const blocks = extractZcodeHarnessFromRequestBody(body);
      if (!blocks) {
        // 学习是静默的：identity 行随客户端升级变化时这里返回 null，缓存会永远停在旧版本，
        // 而 relay 一直发旧 harness → 3012（2026-10-31 事故期间零日志）。至少留一条痕迹。
        const missKey = learnedAppVersion || 'unknown';
        if (!learnMissWarned.has(missKey)) {
          learnMissWarned.add(missKey);
          try {
            console.warn(
              '[zcode-harness] plan 请求体里没有识别到官方 harness（ZCode ' + missKey
              + '），本次不更新缓存；若 relay 持续 3012，多半是 harness 已随客户端升级失效。'
            );
          } catch (_error) { /* 忽略 */ }
        }
        return;
      }
      writeZcodeHarnessSystem({
        fs: fsImpl,
        storePath: harnessStorePath,
        blocks,
        appVersion: learnedAppVersion
      });
    } catch (_error) { /* 学习失败不影响请求 */ }
  };
  const captured = async function aihZcodeCapturedFetch(input, init) {
    let record = null;
    try {
      record = await describeRequest(input, init, maxBodyBytes);
    } catch (_error) {
      record = null;
    }
    if (record) {
      if (logPath) append(record);
      learnHarness(record);
    }
    const response = await original.call(this, input, init);
    if (!logPath) return response;
    try {
      let preview = '';
      try {
        preview = String(await response.clone().text()).slice(0, RESPONSE_PREVIEW_BYTES);
      } catch (_error) {
        preview = '';
      }
      append({
        at: new Date().toISOString(),
        pid: process.pid,
        kind: 'response',
        url: record ? record.url : '',
        status: response && response.status,
        requestId: (response && response.headers && typeof response.headers.get === 'function'
          ? response.headers.get('x-request-id')
          : '') || '',
        bodyPreview: preview
      });
    } catch (_error) { /* 忽略 */ }
    return response;
  };
  captured.__aihZcodeRequestCapture = true;
  globalObj.fetch = captured;
  return true;
}

module.exports = {
  DEFAULT_MARKER_NAME,
  DEFAULT_LOG_NAME,
  installZcodeRequestCapture,
  resolveZcodeRequestCaptureLogPath
};
