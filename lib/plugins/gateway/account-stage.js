'use strict';

// gateway.account：在一次请求的首次选号之前，让插件对「宿主已经筛过的候选账号」给出偏好顺序。
//
// 插件 handler 收到 { provider, model, candidates: [{ accountRef, authType }] }（不含邮箱、凭据等），
// 返回 { prefer: [accountRef, ...] } 或 null（不表态）。多个插件按快照顺序串行（serial），
// 后一个看到的是前一个调整后的候选顺序。
//
// 宿主保证：
//   - 插件只能在候选里挑选与排序，不能扩大候选范围：返回候选之外的账号 → 插件失败；
//   - 偏好只是排序：会话亲和、加密思考链粘性等宿主规则仍然优先；偏好的账号不可用时照常回落；
//   - 失败语义按 failurePolicy：deny（默认）→ 该请求失败；delegate → 忽略这个插件的偏好。

const { PluginError } = require('../sdk/errors');

const CAPABILITY = 'gateway.account';
const DEFAULT_STEP_TIMEOUT_MS = 1000;

function describeCandidate(account) {
  return {
    accountRef: String(account && account.accountRef || ''),
    authType: account && (account.apiKeyMode || account.authType === 'api-key') ? 'api-key' : String(account && account.authType || 'oauth')
  };
}

function stepFailure(item, code, message) {
  const error = new PluginError(code, `插件 ${item.instanceId} 的 ${item.id}：${message}`);
  error.instanceId = item.instanceId;
  error.contributionId = item.id;
  return error;
}

/**
 * @returns {Promise<string[]>} 有序偏好（只含候选里的 accountRef）；没有插件表态时为空数组
 */
async function runAccountStage(runtime, lease, request, options = {}) {
  const chain = lease.snapshot.byCapability.get(CAPABILITY) || [];
  if (!chain.length) return [];
  const candidates = (request.candidates || []).map(describeCandidate).filter((item) => item.accountRef);
  if (!candidates.length) return [];
  const allowed = new Set(candidates.map((item) => item.accountRef));
  let order = candidates.map((item) => item.accountRef);
  const preferred = new Set();
  for (const item of chain) {
    try {
      const response = await runtime.invoke(item.id, {
        provider: request.provider,
        model: request.model,
        candidates: order.map((ref) => candidates.find((candidate) => candidate.accountRef === ref))
      }, { generation: lease.generation, timeoutMs: Number(options.stepTimeoutMs) || DEFAULT_STEP_TIMEOUT_MS, signal: options.signal });
      const result = response.value;
      if (result === undefined || result === null) continue;
      if (typeof result !== 'object' || !Array.isArray(result.prefer)) throw stepFailure(item, 'plugin_result_invalid', '返回值必须是 { prefer: [accountRef] }');
      const prefer = [...new Set(result.prefer.map(String))];
      const foreign = prefer.filter((ref) => !allowed.has(ref));
      if (foreign.length) throw stepFailure(item, 'plugin_scope_violation', `偏好了候选之外的账号：${foreign.join(', ')}`);
      for (const ref of prefer) preferred.add(ref);
      order = [...prefer, ...order.filter((ref) => !prefer.includes(ref))];
    } catch (error) {
      if (item.failurePolicy === 'delegate') {
        options.onDelegated?.({ item, error });
        continue;
      }
      throw error.contributionId ? error : stepFailure(item, error.code || 'plugin_failed', error.message);
    }
  }
  // 最终顺序里只保留被某个插件偏好过的账号：未被提及的账号留给宿主照常选择。
  return order.filter((ref) => preferred.has(ref));
}

module.exports = { CAPABILITY, runAccountStage };
