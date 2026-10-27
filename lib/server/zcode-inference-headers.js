'use strict';

// **zcode 推理请求的客户端身份头**（唯一实现处）。
//
// 事实（本机 3.16.3 的 CLI bundle 与 Desktop app.asar 实测）：官方客户端对 plan 端点的
// 模型请求带一整套 ZCode 身份头 —— `X-ZCode-App-Version` / `X-Title` / `X-Release-Channel` /
// `X-ZCode-Agent` / `X-Platform` / `X-Os-Category` / `X-Os-Version` / `X-Client-Language` /
// `X-Client-Timezone` / `x-zcode-query-source` / `x-zcode-session-type` / `x-request-id` /
// `x-zcode-trace-id` / `x-session-id`，User-Agent 形如 `ZCode/<v> ai-sdk/anthropic/<v>`。
//
// 我们的 relay 此前只透传了**客户端**（Claude Code / Codex）自己的头 + 鉴权头：探测与计费
// 路径有这套身份头（zcode-client-metadata），**推理路径没有**。结果是上游看到「一个不带任何
// ZCode 客户端标记的请求打到 plan 端点」—— 请求画像与官方客户端不一致，是 3012
// (`unusual activity`) 的候选成因之一。
//
// 本模块只**补齐缺失项**：客户端/上游已经给出的同名头一律不覆盖（与 magpie 的
// startHeaders 同策略：ZCode 自己的头优先，agent 的头不上），失败一律 fail-soft。

const { buildZcodeClientRequestMetadata } = require('../account/zcode-client-metadata');

// plan 端点服务的是「CLI 形态」的请求（magpie 实测可用的形状）：
// UA 后缀 + X-Title 都用 CLI 变体，而不是 Electron 宿主变体。
const ZCODE_CLI_USER_AGENT_SUFFIX = 'ai-sdk/anthropic/3.0.81';
const ZCODE_CLI_TITLE = 'Z Code@cli';
// 官方客户端在 plan 端点上声明的发布通道（bundle 实测：production，不是 stable）。
const ZCODE_CLI_RELEASE_CHANNEL = 'production';

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function randomUuid() {
  try {
    return require('node:crypto').randomUUID();
  } catch (_error) {
    return '';
  }
}

// 会话 id 必须是裸 UUID（上游按它做会话/缓存亲和）。aih 自己的会话键可能不是 UUID，
// 那就派生一个稳定的 UUID（同一会话每次相同），拿不到就退化成随机 UUID。
function resolveSessionId(input = {}) {
  const raw = normalizeText(input.sessionKey);
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (uuidRe.test(raw)) return raw.toLowerCase();
  const seed = raw || normalizeText(input.deviceMid);
  if (!seed) return randomUuid();
  try {
    const hash = require('node:crypto').createHash('sha256').update(`zcode-session\0${seed}`).digest('hex');
    return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  } catch (_error) {
    return randomUuid();
  }
}

/**
 * 把 ZCode 客户端身份头补进 headers（就地修改并返回）。
 *
 * @param {object} headers 上游请求头（小写键；就地补）
 * @param {object} input   { fs, processObj, aiHomeDir, accountRef, hostHomeDir, sessionKey, appVersion }
 * @returns {object} 同一个 headers 对象
 */
function applyZcodeInferenceHeaders(headers, input = {}) {
  if (!headers || typeof headers !== 'object') return headers;
  let metadata = null;
  try {
    metadata = buildZcodeClientRequestMetadata(input.fs, {
      processObj: input.processObj,
      aiHomeDir: input.aiHomeDir,
      accountRef: input.accountRef,
      hostHomeDir: input.hostHomeDir,
      appVersion: input.appVersion
    });
  } catch (_error) {
    metadata = null;
  }
  const appVersion = normalizeText(metadata && metadata.appVersion) || normalizeText(input.appVersion);
  const deviceMid = normalizeText(metadata && metadata.deviceMid);
  const base = (metadata && metadata.headers) || {};
  const setIfAbsent = (name, value) => {
    const key = String(name || '').toLowerCase();
    if (!key || headers[key] !== undefined) return;
    const text = normalizeText(value);
    if (text) headers[key] = text;
  };
  const setAlways = (name, value) => {
    const key = String(name || '').toLowerCase();
    const text = normalizeText(value);
    if (key && text) headers[key] = text;
  };
  for (const [name, value] of Object.entries(base)) setIfAbsent(name, value);
  // 身份头（缺一不可的画像项；上游按它们判定「这是不是 ZCode 客户端」）。
  if (appVersion) setAlways('X-ZCode-App-Version', appVersion);
  if (deviceMid) setAlways('X-Device-Mid', deviceMid);
  // 下面三个**覆盖** metadata 的宿主默认值：plan 端点服务的是 CLI 形态的请求
  // （`X-Title: Z Code@cli`、`X-Release-Channel: production`、UA 带 ai-sdk 后缀），
  // 而 zcode-client-metadata 的默认值是 Electron 宿主形态（`Z Code@electron` / stable）。
  setAlways('X-Title', ZCODE_CLI_TITLE);
  setAlways('X-Release-Channel', ZCODE_CLI_RELEASE_CHANNEL);
  if (appVersion) setAlways('user-agent', `ZCode/${appVersion} ${ZCODE_CLI_USER_AGENT_SUFFIX}`);
  setAlways('X-ZCode-Agent', 'glm');
  setAlways('x-zcode-query-source', 'main_turn');
  setAlways('x-zcode-session-type', 'main');
  // 客户端把 OS 版本也作为画像项（`os.release()`）。
  try { setAlways('X-Os-Version', require('node:os').release()); } catch (_error) { /* 忽略 */ }
  setIfAbsent('x-request-id', randomUuid());
  setIfAbsent('x-zcode-trace-id', randomUuid());
  const sessionId = resolveSessionId({ sessionKey: input.sessionKey, deviceMid });
  if (sessionId) {
    setAlways('x-session-id', sessionId);
    setAlways('X-Session-Id', sessionId);
  }
  return headers;
}

module.exports = {
  ZCODE_CLI_USER_AGENT_SUFFIX,
  ZCODE_CLI_TITLE,
  ZCODE_CLI_RELEASE_CHANNEL,
  applyZcodeInferenceHeaders,
  resolveSessionId
};
