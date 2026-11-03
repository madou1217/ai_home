'use strict';

// ChatGPT 登录（OAuth）账号的上游是 chatgpt.com/backend-api/codex/responses：它不存储任何
// response / item——必须 store=false（传 true 直接 400 "Store must be set to false"），因此也解析不了
// previous_response_id 和 input 里的 rs_/msg_ 等 item id。
//
// Go Core 把「OAuth + store:true」和「带 previous_response_id」判为不支持，交回 Node。Node 原先按
// 客户端声明的 store 决定透传还是剥离：store:true 原样发出 → 400；store:false 且只带
// previous_response_id → 剥完成了空请求 → 400 "One of input or previous_response_id … must be provided"。
//
// 这里按上游能力决定，不看客户端声明：
//   - store 一律改为 false，previous_response_id 与 typed item id 一律剥离，对话以 input 内联为准
//     （codex CLI 在这条链路上本就全量内联历史）；字符串 input 改写成等价的 user 消息列表；
//   - 客户端依赖服务端存储续接时（store 未关闭，或剥离后已无 input），上游无从得知上文：
//     本地返回 400 previous_response_not_found，不把缺上下文的请求发出去（否则要么 400，
//     要么模型静默丢掉上文）。API Key 账号直连真正的 OpenAI 存储，不受影响。

const DIAGNOSTIC_HEADERS = Object.freeze([
  'user-agent',
  'originator',
  'x-stainless-lang',
  'x-stainless-package-version'
]);

function isStatelessCodexAccount(account) {
  return !(account && (account.apiKeyMode || account.authType === 'api-key'));
}

function hasResponsesInput(input) {
  if (Array.isArray(input)) return input.length > 0;
  if (typeof input === 'string') return input.trim().length > 0;
  return input != null;
}

/**
 * @returns {null | {statusCode: number, body: object}} 需要在本地拒绝时返回 OpenAI 形状的错误
 */
function findStatelessContinuationConflict(requestJson) {
  const source = requestJson && typeof requestJson === 'object' ? requestJson : {};
  const previousResponseId = String(source.previous_response_id || '').trim();
  if (!previousResponseId) return null;
  if (source.store === false && hasResponsesInput(source.input)) return null;
  return {
    statusCode: 400,
    body: {
      error: {
        message: `Previous response with id '${previousResponseId}' not found. `
          + 'ChatGPT sign-in accounts cannot store responses; send the full conversation in input '
          + 'with store set to false instead of previous_response_id.',
        type: 'invalid_request_error',
        param: 'previous_response_id',
        code: 'previous_response_not_found'
      }
    }
  };
}

// ChatGPT 上游只接受列表形式的 input（字符串 input 返回 400 "Input must be a list"）；
// OpenAI Responses 协议允许字符串，等价于一条 user 文本消息。
function normalizeStatelessInput(input) {
  if (typeof input !== 'string') return input;
  return [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: input }] }];
}

// 只记客户端标识与请求形状，不记请求体：用于认出依赖服务端存储的调用方。
function describeResponsesRequestShape(req, requestJson) {
  const headers = req && req.headers || {};
  const source = requestJson && typeof requestJson === 'object' ? requestJson : {};
  const client = {};
  DIAGNOSTIC_HEADERS.forEach((name) => {
    const value = String(headers[name] || '').trim();
    if (value) client[name] = value.slice(0, 160);
  });
  const input = source.input;
  return {
    client,
    store: source.store === undefined ? 'unset' : source.store,
    stream: source.stream === true,
    previousResponseId: Boolean(String(source.previous_response_id || '').trim()),
    inputType: Array.isArray(input) ? 'array' : input == null ? 'none' : typeof input,
    inputItems: Array.isArray(input) ? input.length : undefined
  };
}

module.exports = {
  describeResponsesRequestShape,
  normalizeStatelessInput,
  findStatelessContinuationConflict,
  isStatelessCodexAccount
};
