'use strict';

// gateway.request：在别名、账号与路由选择之前，按代次快照里的顺序（waterfall）让插件变换或拒绝请求。
//
// 插件 handler 收到 { protocol, path, model, body }，返回：
//   - undefined / null          → 不改动
//   - { body: <object> }        → 用新的请求体继续（模型可以改，改后照常走别名/目录/授权）
//   - { reject: { status?, message? } } → 拒绝请求（status 只允许 4xx，默认 403）
// 每一步之后宿主都核对「身份字段」没被改动：会话/对话/线程标识、续写指针、store、
// prompt_cache_key、metadata 里的会话类字段，以及所有 encrypted_content。改了就按插件失败处理。
//
// 失败语义按贡献项的 failurePolicy：deny（默认）→ 拒绝该请求；delegate → 跳过这个插件，用上一步的结果继续。

const { PluginError } = require('../sdk/errors');

const CAPABILITY = 'gateway.request';
const DEFAULT_STEP_TIMEOUT_MS = 2000;
// 身份字段清单来自插件合同（Go 的 gateway.request 用同一份生成常量）。
const { gatewayRequest } = require('../sdk/contract.generated.json');
const FROZEN_TOP_LEVEL = Object.freeze([...gatewayRequest.frozenTopLevel]);
const FROZEN_METADATA = Object.freeze([...gatewayRequest.frozenMetadata]);

function collectEncryptedContent(value, out = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectEncryptedContent(item, out);
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (key === 'encrypted_content') out.push(JSON.stringify(child));
      else collectEncryptedContent(child, out);
    }
  }
  return out;
}

function identityFingerprint(body) {
  const metadata = body && typeof body.metadata === 'object' && body.metadata ? body.metadata : {};
  return JSON.stringify({
    top: FROZEN_TOP_LEVEL.map((key) => [key, body[key] === undefined ? null : body[key]]),
    metadata: FROZEN_METADATA.map((key) => [key, metadata[key] === undefined ? null : metadata[key]]),
    encrypted: collectEncryptedContent(body)
  });
}

function stepFailure(item, code, message) {
  const error = new PluginError(code, `插件 ${item.instanceId} 的 ${item.id}：${message}`);
  error.instanceId = item.instanceId;
  error.contributionId = item.id;
  return error;
}

function normalizeResult(item, result, current) {
  if (result === undefined || result === null) return { body: current };
  if (typeof result !== 'object' || Array.isArray(result)) throw stepFailure(item, 'plugin_result_invalid', '返回值必须是对象');
  if (result.reject) {
    const status = Number(result.reject.status);
    return {
      reject: {
        status: Number.isInteger(status) && status >= 400 && status < 500 ? status : 403,
        message: String(result.reject.message || '请求被插件拒绝').slice(0, 1000),
        instanceId: item.instanceId,
        contributionId: item.id
      }
    };
  }
  if (!result.body || typeof result.body !== 'object' || Array.isArray(result.body)) {
    throw stepFailure(item, 'plugin_result_invalid', 'body 必须是 JSON 对象');
  }
  return { body: result.body };
}

/**
 * @param {{ invoke: Function }} runtime  runtime-service（只用 invoke）
 * @param {{ snapshot, generation }} lease 请求开始时 acquire() 得到的租约
 * @param {{ protocol, path, body }} request
 * @returns {Promise<{ body, changed: boolean, invoked: number } | { reject }>}
 */
async function runRequestStage(runtime, lease, request, options = {}) {
  const chain = lease.snapshot.byCapability.get(CAPABILITY) || [];
  const original = request.body;
  const fingerprint = identityFingerprint(original);
  const timeoutMs = Number(options.stepTimeoutMs) || DEFAULT_STEP_TIMEOUT_MS;
  let current = original;
  let invoked = 0;
  for (const item of chain) {
    let next;
    try {
      const response = await runtime.invoke(item.id, {
        protocol: request.protocol,
        path: request.path,
        model: typeof current.model === 'string' ? current.model : '',
        body: current
      }, { generation: lease.generation, timeoutMs, signal: options.signal });
      invoked += 1;
      next = normalizeResult(item, response.value, current);
      if (next.reject) return { reject: next.reject, invoked };
      if (identityFingerprint(next.body) !== fingerprint) {
        throw stepFailure(item, 'plugin_identity_modified', '不允许修改会话、续写或加密内容等身份字段');
      }
    } catch (error) {
      if (item.failurePolicy === 'delegate') {
        options.onDelegated?.({ item, error });
        continue;
      }
      const failure = error instanceof PluginError && error.contributionId ? error : stepFailure(item, error.code || 'plugin_failed', error.message);
      throw failure;
    }
    current = next.body;
  }
  return { body: current, changed: current !== original, invoked };
}

module.exports = { CAPABILITY, FROZEN_TOP_LEVEL, identityFingerprint, runRequestStage };
