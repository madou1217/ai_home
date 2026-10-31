'use strict';

// 活动参数的**候选值解析**（UI 下拉框的数据来源）。
//
// 两条纪律：
//   1. 账号选项**不写进描述符**，也不由调度器去查账号库 —— 描述符声明的是类型，
//      具体有哪些账号属于「宿主数据」。所以账号列表通过注入的端口
//      `listAccountIdentities({ provider })` 取得，端口实现在组合根（路由层），
//      它接收 provider 作为**不透明 id**，内部没有任何 provider 名分支。
//   2. 类型选项来自描述符的 kinds 声明；探测结果只用来标注「当前可领/不可领」，
//      不是选项的存在前提 —— 探测失败时用户照样能保存任务。

const { getActivityAction } = require('./actions');
const { describePlanKinds } = require('./plans');

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function findParamField(action, paramKey) {
  const key = normalizeText(paramKey);
  const fields = action && Array.isArray(action.params) ? action.params : [];
  return fields.find((field) => field.key === key) || null;
}

/**
 * @param {object} input
 * @param {string} input.provider
 * @param {string} input.actionId
 * @param {string} input.paramKey
 * @param {object} [input.probe]  探测结果（`{ kinds: [{ id, claimable }] }`），仅用于标注
 * @param {object} [input.deps]   `{ listAccountIdentities }`
 * @returns {Promise<{ok: boolean, paramKey: string, source: string, options: object[], error?: string}>}
 */
async function listActivityParamOptions(input = {}) {
  const provider = normalizeText(input.provider).toLowerCase();
  const action = getActivityAction(provider, input.actionId);
  const paramKey = normalizeText(input.paramKey);
  if (!action) {
    return { ok: false, paramKey, source: 'unknown', options: [], error: `activity_action_unknown:${provider}` };
  }
  const field = findParamField(action, paramKey);
  if (!field) {
    return { ok: false, paramKey, source: 'unknown', options: [], error: `activity_param_unknown:${paramKey}` };
  }

  if (field.type === 'account-refs') {
    const listIdentities = input.deps && input.deps.listAccountIdentities;
    if (typeof listIdentities !== 'function') {
      // 没有账号端口不算错误：前端会显示「留空 = 全部账号」。
      return { ok: true, paramKey, source: 'unavailable', options: [] };
    }
    try {
      const identities = await listIdentities({ provider });
      const options = (Array.isArray(identities) ? identities : [])
        .map((identity) => ({
          value: normalizeText(identity && identity.value),
          label: normalizeText(identity && identity.label) || normalizeText(identity && identity.value),
          description: normalizeText(identity && identity.description)
        }))
        .filter((option) => option.value);
      return { ok: true, paramKey, source: 'accounts', options };
    } catch (error) {
      return {
        ok: true,
        paramKey,
        source: 'unavailable',
        options: [],
        error: `activity_param_options_failed:${normalizeText(error && error.message) || 'unknown'}`
      };
    }
  }

  if (field.type === 'enum') {
    if (field.optionsFrom === 'kinds') {
      const probed = input.probe && Array.isArray(input.probe.kinds) ? input.probe.kinds : null;
      const claimable = new Map(
        (probed || []).map((entry) => [normalizeText(entry && entry.id), entry])
      );
      const options = describePlanKinds(action.kinds, probed ? [] : undefined).map((kind) => {
        const hit = claimable.get(kind.id);
        return {
          value: kind.id,
          label: kind.label,
          description: kind.description,
          ...(hit ? {
            disabled: hit.claimable === false,
            hint: hit.claimable === false ? '当前不可领' : '当前可领'
          } : {})
        };
      });
      return { ok: true, paramKey, source: 'declared', options };
    }
    const options = (Array.isArray(field.options) ? field.options : []).map((option) => ({
      value: option.value,
      label: option.label,
      description: option.description || ''
    }));
    return { ok: true, paramKey, source: 'declared', options };
  }

  // string / boolean 没有候选值。
  return { ok: true, paramKey, source: 'freeform', options: [] };
}

/** 一次性解析某个动作的全部参数选项（UI 打开编辑器时调用）。 */
async function listActivityActionParamOptions(input = {}) {
  const provider = normalizeText(input.provider).toLowerCase();
  const action = getActivityAction(provider, input.actionId);
  if (!action) {
    return { ok: false, error: `activity_action_unknown:${provider}`, params: [] };
  }
  const fields = Array.isArray(action.params) ? action.params : [];
  const params = [];
  for (const field of fields) {
    const resolved = await listActivityParamOptions({
      provider,
      actionId: action.id,
      paramKey: field.key,
      probe: input.probe,
      deps: input.deps
    });
    params.push({
      key: field.key,
      label: field.label,
      type: field.type,
      description: field.description || '',
      required: field.required === true,
      emptyMeans: field.emptyMeans || 'any',
      ...(field.maxItems ? { maxItems: field.maxItems } : {}),
      source: resolved.source,
      options: resolved.options,
      ...(resolved.error ? { error: resolved.error } : {})
    });
  }
  return { ok: true, provider, actionId: action.id, params };
}

module.exports = {
  listActivityParamOptions,
  listActivityActionParamOptions
};
