'use strict';

// Qoder 客户端协议布局表（Qoder Client Layout Table）—— 版本化事实源。
//
// 为什么需要：qoder / qodercn 的推理面不是公开的 OpenAI 兼容 API，而是官方客户端
// （qodercli / qoderclicn）的私有链路：端点从客户端缓存解析，请求要过内嵌 WASM 的
// `prepareInferRequest` 改写（url / headers / body），身份头由客户端在 MCP 注入上下文
// 中设置。逆向结论会随客户端版本变化，所以**按版本钉住**：每条布局记录 CLI 版本、
// 二进制 sha256、取证日期与「已证明 / 未证明」边界；消费方（HTTP transport / 原生
// 会话 / 诊断）只读本表，不按版本号在业务代码里写 if。
//
// 取证方式（2026-10-19，qodercli 1.1.73）：
//   * 端点：~/.qoder/.cache/qoder-client-endpoint-cache.json（客户端自己写的最新区集）
//   * 头名与注入语义：二进制里 `t5e` 的上游函数体（见 docs/providers/qoder-client-protocol.md）
//   * 账户面路径：二进制里的字符串常量（/api/v2/quota/usage 等）
//   * 推理链路：`inference.remoteChat.stream` 的 builder 与 `ModelServerHttpRequest`
//
// 纪律：本表只记「能从二进制/客户端文件直接读到」的事实。推测必须放进 `unproven`
// 列表，绝不允许伪装成 header 常量。任何值都不包含用户 token / machine id。

const QODER_IDENTITY_HEADERS = Object.freeze({
  model: 'X-Qoder-Model',
  safetyTag: 'X-Qoder-Model-Safety-Tag',
  sessionId: 'X-Qoder-Session-Id',
  internalSessionId: 'x-internal-session-id',
  internalModelKey: 'x-internal-model-key',
  internalBusinessId: 'x-internal-business-id',
  sessionAlias: 'X-Session-ID',
  requestSetId: 'X-RequestSet-ID'
});

// `t5e` 每次注入前先删除这些名字，避免调用方自带的同名头被原样转发。
const QODER_IDENTITY_HEADER_ORDER = Object.freeze([
  QODER_IDENTITY_HEADERS.model,
  QODER_IDENTITY_HEADERS.safetyTag,
  QODER_IDENTITY_HEADERS.sessionId,
  QODER_IDENTITY_HEADERS.internalSessionId,
  QODER_IDENTITY_HEADERS.internalModelKey,
  QODER_IDENTITY_HEADERS.internalBusinessId,
  QODER_IDENTITY_HEADERS.sessionAlias,
  QODER_IDENTITY_HEADERS.requestSetId
]);

// `ModelServerHttpRequest` 在每一条模型服务请求上设置的固定头（Authorization 单独注入）。
const QODER_MODEL_SERVER_HEADERS = Object.freeze({
  accept: 'text/event-stream',
  contentType: 'application/json',
  authorization: 'Authorization',
  requestId: 'X-Request-ID',
  sessionId: 'X-Session-ID'
});

// 账户面（额度 / 套餐 / 状态）的路径。qoder 与 qodercn 形状相同，只有主机不同。
const QODER_ACCOUNT_ROUTES = Object.freeze({
  plan: '/api/v2/user/plan',
  status: '/api/v3/user/status',
  quota: '/api/v2/quota/usage',
  usagePresentation: '/sash/api/v2/me/usage'
});

const QODER_ACCOUNT_BASES = Object.freeze({
  qoder: 'https://openapi.qoder.sh',
  qodercn: 'https://openapi.qoder.com.cn'
});

const QODER_CLIENT_LAYOUTS = Object.freeze([
  Object.freeze({
    id: 'qoder-cli-1.1.73',
    provider: 'qoder',
    status: 'verified',
    cliVersion: '1.1.73',
    capturedAt: '2026-10-19',
    binary: Object.freeze({
      path: '~/.qoder/bin/qodercli/qodercli-1.1.73',
      sha256: 'ec2180c0d8425d882acb991d756e6617a0343546574792836a1286164ccb3327',
      sizeBytes: 162892288
    }),
    endpoints: Object.freeze({
      inference: 'https://api3.qoder.sh',
      securityInference: 'https://api2.qoder.sh',
      center: 'https://center.qoder.sh',
      openapi: 'https://openapi.qoder.sh',
      cachePath: '~/.qoder/.cache/qoder-client-endpoint-cache.json'
    }),
    accountRoutes: QODER_ACCOUNT_ROUTES,
    inference: Object.freeze({
      operation: 'inference.remoteChat.stream',
      method: 'POST',
      path: '/',
      stream: true,
      bodyFields: Object.freeze([
        'model',
        'messages',
        'tools',
        'temperature',
        'max_tokens',
        'stop',
        'stream',
        'parameters',
        'patches',
        'reasoning_effort',
        'generation',
        'requestId',
        'requestSetId',
        'sessionId',
        'sourceSessionId',
        'taskId',
        'business',
        'customModel',
        'modelConfig',
        'remoteChatAsk'
      ]),
      wasmSigning: Object.freeze({
        builderCall: 'withWasmInferSigningMeta',
        wasmCall: 'prepareInferRequest',
        inputs: Object.freeze(['model_config.key', 'model_config.source']),
        rewrites: Object.freeze(['url', 'headers', 'body']),
        wireBodyIsClientJson: false
      })
    }),
    modelServerHeaders: QODER_MODEL_SERVER_HEADERS,
    identityHeaders: QODER_IDENTITY_HEADERS,
    identityInjection: Object.freeze({
      helper: 't5e',
      appliesTo: 'mcp',
      stripsBeforeSet: true,
      valueTransform: 'strip non-printable ASCII + trim',
      modelValue: 'trim(displayName) || trim(key)',
      sessionAliasValue: 'same value as X-Qoder-Session-Id',
      internalContextRule: 'x-internal-* only when sessionId + modelKey + businessId are all non-empty'
    }),
    unproven: Object.freeze([
      '身份头在推理链路（非 MCP 工具调用）上的实际发送集合与取值',
      'safetyTag / internalContext.modelKey / internalContext.businessId 在推理时的来源',
      'WASM prepareInferRequest 之后的精确 URL / body / 签名头',
      '付费账号走普通 HTTP 是否可行（当前本机两个账号都是 Free，裸请求 402/116）'
    ])
  }),
  Object.freeze({
    id: 'qodercn-cli-unverified',
    provider: 'qodercn',
    status: 'unverified',
    cliVersion: null,
    capturedAt: '2026-10-19',
    reason: 'qoderclicn 未安装，无法对当前版本重新取证；端点来自此前证据，不冒充已验证',
    binary: null,
    endpoints: Object.freeze({
      inference: 'https://gateway.qoder.com.cn',
      openapi: 'https://openapi.qoder.com.cn'
    }),
    accountRoutes: QODER_ACCOUNT_ROUTES,
    inference: null,
    modelServerHeaders: QODER_MODEL_SERVER_HEADERS,
    identityHeaders: QODER_IDENTITY_HEADERS,
    identityInjection: null,
    unproven: Object.freeze([
      '当前 qoderclicn 版本的端点缓存、身份头注入与 WASM 签名链路',
      '国内站推理主机在用户网络上的可达性（当前网络曾返回 ALB 503）'
    ])
  })
]);

function normalizeString(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

/**
 * 复刻 `t5e` 的值清洗：只保留可打印 ASCII（0x20-0x7E），再去首尾空白。
 * 注意这里**不做** URL 编码，也不改大小写；官方实现就是这样写的。
 */
function sanitizeQoderHeaderValue(value) {
  return normalizeString(value).replace(/[^\x20-\x7E]/g, '').trim();
}

/**
 * 解析 provider 的客户端布局。
 * 返回 `resolution`：`version`（版本精确命中）/ `version_mismatch`（版本未登记，回落最新）/
 * `latest`（调用方没给版本）。未知 provider 返回 null，调用方必须 fail-closed。
 */
function resolveQoderClientLayout(input = {}) {
  const provider = normalizeString(input.provider).toLowerCase() || 'qoder';
  const version = normalizeString(input.version);
  const candidates = QODER_CLIENT_LAYOUTS.filter((layout) => layout.provider === provider);
  if (candidates.length === 0) return null;
  const exact = version ? candidates.find((layout) => layout.cliVersion === version) : null;
  const selected = exact || candidates[0];
  return {
    ...selected,
    resolution: exact ? 'version' : (version ? 'version_mismatch' : 'latest')
  };
}

/**
 * 复刻 `t5e` 的身份头注入。只输出非空值；`x-internal-*` 必须三件套齐全才写，
 * 与官方实现一致（缺一个就整组不写，绝不拼接半套）。
 */
function buildQoderIdentityHeaders(input = {}) {
  const headers = {};
  const model = sanitizeQoderHeaderValue(input.displayName)
    || sanitizeQoderHeaderValue(input.modelKey);
  if (model) headers[QODER_IDENTITY_HEADERS.model] = model;

  const sessionId = sanitizeQoderHeaderValue(input.sessionId);
  if (sessionId) {
    headers[QODER_IDENTITY_HEADERS.sessionId] = sessionId;
    headers[QODER_IDENTITY_HEADERS.sessionAlias] = sessionId;
  }

  const requestSetId = sanitizeQoderHeaderValue(input.requestSetId);
  if (requestSetId) headers[QODER_IDENTITY_HEADERS.requestSetId] = requestSetId;

  const safetyTag = sanitizeQoderHeaderValue(input.safetyTag);
  if (safetyTag) headers[QODER_IDENTITY_HEADERS.safetyTag] = safetyTag;

  const internalSessionId = sanitizeQoderHeaderValue(input.internalSessionId);
  const internalModelKey = sanitizeQoderHeaderValue(input.internalModelKey);
  const internalBusinessId = sanitizeQoderHeaderValue(input.internalBusinessId);
  if (internalSessionId && internalModelKey && internalBusinessId) {
    headers[QODER_IDENTITY_HEADERS.internalSessionId] = internalSessionId;
    headers[QODER_IDENTITY_HEADERS.internalModelKey] = internalModelKey;
    headers[QODER_IDENTITY_HEADERS.internalBusinessId] = internalBusinessId;
  }
  return headers;
}

/**
 * 模型服务请求的固定头。Authorization 只在 token 非空时写；调用方不得把 token
 * 拼进 URL / 日志。
 */
function buildQoderModelServerHeaders(input = {}) {
  const layout = input.layout || resolveQoderClientLayout({
    provider: input.provider || 'qoder',
    version: input.version
  }) || {};
  const names = layout.modelServerHeaders || QODER_MODEL_SERVER_HEADERS;
  const headers = {
    Accept: names.accept,
    'Content-Type': names.contentType
  };
  const token = sanitizeQoderHeaderValue(input.token);
  if (token) headers[names.authorization] = `Bearer ${token}`;
  const requestId = sanitizeQoderHeaderValue(input.requestId);
  if (requestId) headers[names.requestId] = requestId;
  const sessionId = sanitizeQoderHeaderValue(input.sessionId);
  if (sessionId) headers[names.sessionId] = sessionId;
  return headers;
}

module.exports = {
  QODER_ACCOUNT_BASES,
  QODER_ACCOUNT_ROUTES,
  QODER_CLIENT_LAYOUTS,
  QODER_IDENTITY_HEADERS,
  QODER_IDENTITY_HEADER_ORDER,
  QODER_MODEL_SERVER_HEADERS,
  buildQoderIdentityHeaders,
  buildQoderModelServerHeaders,
  resolveQoderClientLayout,
  sanitizeQoderHeaderValue
};
