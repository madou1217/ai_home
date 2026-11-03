'use strict';

// 活动参数的**类型适配器**（唯一认识参数语义的地方）。
//
// 分工：provider 描述符只声明「有哪些参数、什么类型」（见 lib/providers/contract.js），
// 计划任务与调度器只做「把用户填的值存下来、交给这里归一」；真正的语义 ——
// 什么算空、空值代表什么、要不要筛账号 —— 全部落在类型适配器里。
// 于是新增一个 provider / 动作，不需要改调度器一行代码。
//
// 今天的四种类型：
//   account-refs —— 账号引用列表；**空数组 = 不过滤（全部账号）**，这是向后兼容的关键
//   enum         —— 枚举；取值来自描述符的 options 或 kinds
//   string       —— 自由文本
//   boolean      —— 开关
//
// 返回值一律结构化，不抛异常：调度器要把「参数非法」写进运行记录，而不是让任务崩掉。

const MAX_STRING_LENGTH = 128;

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isBlank(value) {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function enumValuesOf(field, action) {
  if (Array.isArray(field.options) && field.options.length > 0) {
    return field.options.map((option) => option.value);
  }
  if (field.optionsFrom === 'kinds') {
    const kinds = action && Array.isArray(action.kinds) ? action.kinds : [];
    return kinds.map((kind) => kind.id);
  }
  return [];
}

const ACTIVITY_PARAM_ADAPTERS = Object.freeze({
  'account-refs': Object.freeze({
    normalize(value, field) {
      const list = Array.isArray(value) ? value : [];
      const refs = [...new Set(list.map((item) => normalizeText(item)).filter(Boolean))].sort();
      if (field.maxItems && refs.length > field.maxItems) {
        return { error: `activity_param_too_many:${field.key}` };
      }
      return { value: refs };
    },
    filterTargets(targets, refs) {
      if (!Array.isArray(refs) || refs.length === 0) return { targets, unknown: [] };
      const wanted = new Set(refs);
      const kept = [];
      const present = new Set();
      for (const target of Array.isArray(targets) ? targets : []) {
        const accountRef = normalizeText(target && target.record && target.record.accountRef);
        if (!wanted.has(accountRef)) continue;
        kept.push(target);
        present.add(accountRef);
      }
      return { targets: kept, unknown: refs.filter((ref) => !present.has(ref)) };
    }
  }),
  enum: Object.freeze({
    normalize(value, field, action) {
      const raw = normalizeText(value);
      if (!raw) return { value: '' };
      const allowed = enumValuesOf(field, action);
      if (allowed.length > 0 && !allowed.includes(raw)) {
        return { error: `activity_param_value_invalid:${field.key}` };
      }
      return { value: raw };
    }
  }),
  string: Object.freeze({
    normalize(value, field) {
      const raw = normalizeText(value);
      if (raw.length > MAX_STRING_LENGTH) return { error: `activity_param_too_long:${field.key}` };
      return { value: raw };
    }
  }),
  boolean: Object.freeze({
    normalize(value) {
      return { value: value === true };
    }
  })
});

/**
 * 按描述符 schema 归一参数。
 * 未知 key 直接丢弃 —— schema 才是唯一真相，调用方传多字段不应报错。
 * @returns {{ok: true, params: object} | {ok: false, error: string}}
 */
function normalizeActivityParams(action, raw) {
  const fields = action && Array.isArray(action.params) ? action.params : [];
  if (fields.length === 0) return { ok: true, params: {} };
  const source = raw && typeof raw === 'object' ? raw : {};
  const params = {};
  for (const field of fields) {
    const adapter = ACTIVITY_PARAM_ADAPTERS[field.type];
    if (!adapter) return { ok: false, error: `activity_param_type_unknown:${field.key}` };
    const incoming = source[field.key];
    if (isBlank(incoming) && field.required === true) {
      return { ok: false, error: `activity_param_required:${field.key}` };
    }
    const normalized = adapter.normalize(incoming, field, action);
    if (normalized.error) return { ok: false, error: normalized.error };
    // 空值不进 params：指纹与展示都按「没填」处理，避免 `[]` 与缺省产生两个键。
    if (isBlank(normalized.value)) continue;
    params[field.key] = normalized.value;
  }
  return { ok: true, params };
}

/**
 * 把声明里的「目标过滤器类型」依次作用到 targets 上。
 * 只有声明了 filterTargets 的类型（今天只有 account-refs）会改变执行范围。
 * @returns {{targets: object[], unknownAccountRefs: string[]}}
 */
function resolveActivityTargets(action, params, targets) {
  const fields = action && Array.isArray(action.params) ? action.params : [];
  let current = Array.isArray(targets) ? targets : [];
  const unknown = [];
  for (const field of fields) {
    const adapter = ACTIVITY_PARAM_ADAPTERS[field.type];
    if (!adapter || typeof adapter.filterTargets !== 'function') continue;
    const value = params && params[field.key];
    const out = adapter.filterTargets(current, value);
    current = out.targets;
    unknown.push(...out.unknown);
  }
  return { targets: current, unknownAccountRefs: [...new Set(unknown)] };
}

/** 给 UI 用的字段清单：去掉执行细节，只留渲染需要的东西。 */
function describeActivityParams(action) {
  const fields = action && Array.isArray(action.params) ? action.params : [];
  return fields.map((field) => ({
    key: field.key,
    label: field.label,
    type: field.type,
    description: field.description || '',
    required: field.required === true,
    emptyMeans: field.emptyMeans || 'any',
    ...(field.maxItems ? { maxItems: field.maxItems } : {}),
    ...(Array.isArray(field.options) ? { options: field.options.map((option) => ({ ...option })) } : {}),
    ...(field.optionsFrom ? { optionsFrom: field.optionsFrom } : {})
  }));
}

module.exports = {
  ACTIVITY_PARAM_ADAPTERS,
  normalizeActivityParams,
  resolveActivityTargets,
  describeActivityParams
};
