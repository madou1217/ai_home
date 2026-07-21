'use strict';

const {
  isRealProviderModelId,
  listModelIdLookupKeys,
  normalizeModelId
} = require('./model-id');

const MODEL_ID_FIELDS = Object.freeze([
  'id',
  'model',
  'modelId',
  'model_id',
  'newModelId',
  'new_model_id'
]);

// 注意:vertexModelId(如 claude-opus-4-6@default)是 Vertex 后端的内部版本 id,
// cloudcode 接口对它返回 404,绝不能作为 wire id;wire 应回退到公开模型 id。
const WIRE_MODEL_ID_FIELDS = Object.freeze([
  'wireId',
  'upstreamModel',
  'defaultAgentModelId',
  'default_agent_model_id',
  'upstreamModelId',
  'upstream_model_id',
  'wireModelId',
  'wire_model_id'
]);

const DISPLAY_NAME_FIELDS = Object.freeze([
  'displayName',
  'display_name',
  'name',
  'title'
]);

const ALIAS_FIELDS = Object.freeze([
  'aliases',
  'alias',
  'deprecatedModelIds',
  'deprecated_model_ids',
  'commandModelIds',
  'command_model_ids'
]);

// 档位模型 id(如 gemini-3.5-flash-high/-low)是可直接请求的真实模型,
// 必须提升为独立 descriptor 进入目录,而不是作为父模型的 alias 被吞掉。
const TIERED_MODEL_ID_FIELDS = Object.freeze([
  'tieredModelIds',
  'tiered_model_ids'
]);

const MODEL_CONTAINER_KEYS = Object.freeze(new Set([
  'models',
  'modeldetails',
  'model_details',
  'availablemodels',
  'available_models',
  'availablemodeldetails',
  'available_model_details',
  'modeldetailsbyid',
  'model_details_by_id',
  'modeldetailsbykey',
  'model_details_by_key',
  'buckets'
]));

function normalizeProvider(provider) {
  return String(provider || '').trim().toLowerCase();
}

function normalizeFieldName(name) {
  return String(name || '').trim().replace(/[^a-z0-9]+/gi, '').toLowerCase();
}

function readStringField(source, fieldNames) {
  if (!source || typeof source !== 'object') return '';
  for (const fieldName of fieldNames) {
    const direct = source[fieldName];
    if (direct !== undefined && direct !== null) {
      const text = String(direct || '').trim();
      if (text) return text;
    }
  }
  const wanted = new Set(fieldNames.map(normalizeFieldName));
  for (const [key, value] of Object.entries(source)) {
    if (!wanted.has(normalizeFieldName(key))) continue;
    const text = String(value || '').trim();
    if (text) return text;
  }
  return '';
}

function hasAnyField(source, fieldNames) {
  if (!source || typeof source !== 'object') return false;
  const wanted = new Set(fieldNames.map(normalizeFieldName));
  return Object.keys(source).some((key) => wanted.has(normalizeFieldName(key)));
}

function stripCodeAssistModelSuffix(model) {
  return String(model || '').trim().replace(/_vertex$/i, '');
}

function readPublicModelId(source, context = {}) {
  // 真实负载里 models.* 条目的内部 model 字段常是 MODEL_PLACEHOLDER_* 内部枚举,
  // 此时必须回退到 models 容器键(即真实可请求的模型 id),否则整个条目被丢弃。
  const candidates = [
    readStringField(source, MODEL_ID_FIELDS),
    String(context.modelId || '').trim()
  ];
  for (const raw of candidates) {
    const id = stripCodeAssistModelSuffix(raw);
    if (id && isRealProviderModelId(id)) return id;
  }
  return '';
}

function readWireModelId(source, context = {}, fallback = '') {
  // wire id 同样跳过内部枚举,取第一个真实 id;全不可用时退回 fallback(public id)。
  const candidates = [
    readStringField(source, WIRE_MODEL_ID_FIELDS),
    readStringField(source, MODEL_ID_FIELDS),
    String(context.modelId || '').trim()
  ];
  for (const raw of candidates) {
    const id = stripCodeAssistModelSuffix(raw);
    if (id && isRealProviderModelId(id)) return id;
  }
  return stripCodeAssistModelSuffix(fallback) || fallback;
}

function collectStrings(value, out = []) {
  if (value === undefined || value === null) return out;
  if (typeof value === 'string' || typeof value === 'number') {
    const text = String(value || '').trim();
    if (text) out.push(text);
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectStrings(item, out));
    return out;
  }
  if (value && typeof value === 'object') {
    Object.entries(value).forEach(([key, item]) => {
      const keyText = String(key || '').trim();
      if (keyText) out.push(keyText);
      collectStrings(item, out);
    });
  }
  return out;
}

function uniqueStrings(values) {
  const seen = new Set();
  const out = [];
  (Array.isArray(values) ? values : []).forEach((value) => {
    const text = String(value || '').trim();
    const normalized = normalizeModelId(text);
    if (!text || seen.has(normalized)) return;
    seen.add(normalized);
    out.push(text);
  });
  return out;
}

function readAliases(source, displayName, publicId, wireId) {
  const aliases = [];
  if (displayName) aliases.push(displayName);
  ALIAS_FIELDS.forEach((fieldName) => {
    if (source && Object.prototype.hasOwnProperty.call(source, fieldName)) {
      collectStrings(source[fieldName], aliases);
    }
  });
  if (source && typeof source === 'object') {
    const wanted = new Set(ALIAS_FIELDS.map(normalizeFieldName));
    Object.entries(source).forEach(([key, value]) => {
      if (wanted.has(normalizeFieldName(key))) collectStrings(value, aliases);
    });
  }
  return uniqueStrings(aliases)
    .filter((alias) => {
      const normalized = normalizeModelId(alias);
      return normalized
        && normalized !== normalizeModelId(publicId)
        && normalized !== normalizeModelId(wireId);
    });
}

function normalizeCodeAssistModelDescriptor(provider, value, context = {}) {
  if (typeof value === 'string') {
    const id = stripCodeAssistModelSuffix(value);
    if (!isRealProviderModelId(id)) return null;
    const wireId = stripCodeAssistModelSuffix(value) || id;
    return {
      provider: normalizeProvider(provider),
      id,
      modelId: id,
      wireId,
      upstreamModel: wireId,
      displayName: '',
      aliases: []
    };
  }
  if (!value || typeof value !== 'object') return null;
  const publicId = readPublicModelId(value, context);
  if (!isRealProviderModelId(publicId)) return null;
  const wireId = readWireModelId(value, context, publicId);
  const displayName = readStringField(value, DISPLAY_NAME_FIELDS);
  return {
    provider: normalizeProvider(provider),
    id: publicId,
    modelId: publicId,
    wireId,
    upstreamModel: wireId,
    displayName,
    aliases: readAliases(value, displayName, publicId, wireId)
  };
}

function isModelContainerKey(key) {
  return MODEL_CONTAINER_KEYS.has(normalizeFieldName(key));
}

function isTieredModelIdKey(key) {
  const normalized = normalizeFieldName(key);
  return TIERED_MODEL_ID_FIELDS.some((fieldName) => normalizeFieldName(fieldName) === normalized);
}

// 只收集叶子字符串值,不收集对象键,避免 { high: 'gemini-3.5-flash-high' } 里的
// 档位标签 'high' 被误当成模型 id。
function collectTieredModelIds(value, out = []) {
  if (value === undefined || value === null) return out;
  if (typeof value === 'string' || typeof value === 'number') {
    const text = String(value || '').trim();
    if (text) out.push(text);
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectTieredModelIds(item, out));
    return out;
  }
  if (typeof value === 'object') {
    Object.values(value).forEach((item) => collectTieredModelIds(item, out));
  }
  return out;
}

function collectTieredModelDescriptors(provider, value, out) {
  collectTieredModelIds(value).forEach((rawId) => {
    const id = stripCodeAssistModelSuffix(rawId);
    if (!isRealProviderModelId(id)) return;
    pushDescriptor(out, normalizeCodeAssistModelDescriptor(provider, id));
  });
}

function isDescriptorMetadataKey(key) {
  const normalized = normalizeFieldName(key);
  return MODEL_ID_FIELDS.concat(WIRE_MODEL_ID_FIELDS, DISPLAY_NAME_FIELDS, ALIAS_FIELDS)
    .map(normalizeFieldName)
    .includes(normalized);
}

function pushDescriptor(out, descriptor) {
  if (!descriptor || !descriptor.id) return;
  out.push(descriptor);
}

function collectDescriptorCandidates(provider, value, out, context = {}) {
  if (typeof value === 'string') {
    pushDescriptor(out, normalizeCodeAssistModelDescriptor(provider, value, context));
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectDescriptorCandidates(provider, item, out));
    return;
  }
  if (!value || typeof value !== 'object') return;

  if (hasAnyField(value, MODEL_ID_FIELDS) || context.modelId) {
    pushDescriptor(out, normalizeCodeAssistModelDescriptor(provider, value, context));
  }

  Object.entries(value).forEach(([key, child]) => {
    if (isModelContainerKey(key)) {
      collectDescriptorContainer(provider, child, out);
      return;
    }
    if (isTieredModelIdKey(key)) {
      collectTieredModelDescriptors(provider, child, out);
      return;
    }
    if (isDescriptorMetadataKey(key)) return;
    if (child && typeof child === 'object') {
      collectDescriptorCandidates(provider, child, out);
    }
  });
}

function collectDescriptorContainer(provider, value, out) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectDescriptorCandidates(provider, item, out));
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (hasAnyField(value, MODEL_ID_FIELDS)) {
    collectDescriptorCandidates(provider, value, out);
    return;
  }
  Object.entries(value).forEach(([key, child]) => {
    if (child && typeof child === 'object') {
      collectDescriptorCandidates(provider, child, out, { modelId: key });
    } else if (typeof child === 'string') {
      pushDescriptor(out, normalizeCodeAssistModelDescriptor(provider, child));
    }
  });
}

function dedupeDescriptors(descriptors) {
  const byId = new Map();
  const hasSpecificWire = (descriptor) => (
    descriptor
    && descriptor.wireId
    && normalizeModelId(descriptor.wireId) !== normalizeModelId(descriptor.id)
  );
  (Array.isArray(descriptors) ? descriptors : []).forEach((descriptor) => {
    const normalized = normalizeModelId(descriptor && descriptor.id);
    if (!normalized) return;
    if (!byId.has(normalized)) {
      byId.set(normalized, {
        ...descriptor,
        aliases: uniqueStrings(descriptor.aliases || [])
      });
      return;
    }
    const previous = byId.get(normalized);
    const wireId = hasSpecificWire(descriptor)
      ? descriptor.wireId
      : (previous.wireId || descriptor.wireId);
    byId.set(normalized, {
      ...previous,
      ...descriptor,
      wireId,
      upstreamModel: wireId || previous.upstreamModel || descriptor.upstreamModel,
      displayName: descriptor.displayName || previous.displayName,
      aliases: uniqueStrings([
        ...(previous.aliases || []),
        ...(descriptor.aliases || [])
      ])
    });
  });
  return Array.from(byId.values()).sort((a, b) => a.id.localeCompare(b.id));
}

// 上游 fetchAvailableModels 响应顶层的 deprecatedModelIds 是「旧模型 id → 新模型 id」的转发表
// （如 antigravity: {"gemini-3.1-pro-high":"gemini-pro-agent"}）。把旧 id 注册成目标(新)描述符的
// 别名，使请求旧 id 时能解析到新模型的 wireId。否则旧/非 agent 模型被原样发往 antigravity agent
// 端点 → INVALID_ARGUMENT(400)。这是 agy「直接报错」的根因：转发表此前被解析但从未应用。
function applyDeprecatedModelAliases(payload, descriptors) {
  const raw = payload && (payload.deprecatedModelIds || payload.deprecated_model_ids);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return descriptors;
  const byKey = new Map();
  descriptors.forEach((descriptor) => {
    [descriptor.id, descriptor.modelId, descriptor.wireId, descriptor.upstreamModel].forEach((value) => {
      const key = String(value || '').trim();
      if (key && !byKey.has(key)) byKey.set(key, descriptor);
    });
  });
  Object.entries(raw).forEach(([fromId, toValue]) => {
    const from = String(fromId || '').trim();
    const to = String(
      toValue && typeof toValue === 'object' ? (toValue.newModelId || toValue.new_model_id || '') : (toValue || '')
    ).trim();
    if (!from || !to) return;
    const target = byKey.get(to);
    if (!target || target.id === from) return;
    const targetWire = String(target.wireId || target.upstreamModel || target.id || to).trim();
    // 废弃模型常仍作为独立描述符存在于可用列表里（id===from），单纯加别名会被它自己的 id 命中而遮蔽。
    // 必须把该废弃描述符自身的 wire 指向新模型，使转发优先于其自有 wire（请求 from → 实际发 to-wire）。
    const fromDescriptor = byKey.get(from);
    if (fromDescriptor && fromDescriptor.id === from && targetWire) {
      fromDescriptor.wireId = targetWire;
      fromDescriptor.upstreamModel = targetWire;
    }
    // 同时把 from 注册成新模型别名，覆盖 from 没有独立描述符的情况。
    if (!Array.isArray(target.aliases)) target.aliases = [];
    if (!target.aliases.includes(from)) target.aliases.push(from);
  });
  return descriptors;
}

function extractCodeAssistModelDescriptors(provider, payload) {
  const descriptors = [];
  collectDescriptorCandidates(provider, payload, descriptors);
  if (descriptors.length === 0) {
    collectDescriptorContainer(provider, payload, descriptors);
  }
  return applyDeprecatedModelAliases(payload, dedupeDescriptors(descriptors));
}

function collectSourceDescriptors(provider, source) {
  const descriptors = [];
  const add = (items) => {
    (Array.isArray(items) ? items : []).forEach((item) => {
      pushDescriptor(descriptors, normalizeCodeAssistModelDescriptor(provider, item));
    });
  };

  if (Array.isArray(source)) {
    add(source);
  } else if (source && typeof source === 'object') {
    add(source.descriptors);
    add(source.modelDescriptors);
    add(source.codeAssistModelDescriptors);
    add(source.availableModelDescriptors);
    if (source.account && typeof source.account === 'object') {
      add(source.account.codeAssistModelDescriptors);
      add(source.account.availableModelDescriptors);
      add(source.account.modelDescriptors);
    }
  }

  return dedupeDescriptors(descriptors);
}

function createCodeAssistModelDescriptorIndex(provider, descriptors) {
  const normalizedProvider = normalizeProvider(provider);
  const index = new Map();
  dedupeDescriptors(descriptors).forEach((descriptor) => {
    if (normalizedProvider && normalizeProvider(descriptor.provider) && normalizeProvider(descriptor.provider) !== normalizedProvider) {
      return;
    }
    [
      descriptor.id,
      descriptor.modelId,
      descriptor.wireId,
      descriptor.upstreamModel,
      descriptor.displayName,
      ...(Array.isArray(descriptor.aliases) ? descriptor.aliases : [])
    ].forEach((value) => {
      listModelIdLookupKeys(value).forEach((key) => {
        if (key && !index.has(key)) index.set(key, descriptor);
      });
    });
  });
  return index;
}

function resolveCodeAssistModelDescriptor(provider, model, source = {}) {
  const normalizedModel = normalizeModelId(model);
  if (!normalizedModel) return null;
  const descriptors = collectSourceDescriptors(provider, source);
  const index = createCodeAssistModelDescriptorIndex(provider, descriptors);
  const lookupKey = listModelIdLookupKeys(model).find((key) => index.has(key));
  return lookupKey ? index.get(lookupKey) : null;
}

function resolveCodeAssistWireModelId(provider, model, source = {}) {
  const descriptor = resolveCodeAssistModelDescriptor(provider, model, source);
  if (!descriptor) return String(model || '').trim();
  return String(descriptor.wireId || descriptor.upstreamModel || descriptor.id || model || '').trim();
}

function resolveCodeAssistModelId(provider, model, source = {}) {
  const descriptor = resolveCodeAssistModelDescriptor(provider, model, source);
  return descriptor ? descriptor.id : String(model || '').trim();
}

function resolveCodeAssistUpstreamModel(provider, model, source = {}) {
  return resolveCodeAssistWireModelId(provider, model, source);
}

function findCodeAssistModelRoute(provider, model, source = {}) {
  return resolveCodeAssistModelDescriptor(provider, model, source);
}

function listCodeAssistModelAliases(provider, source = {}) {
  return collectSourceDescriptors(provider, source)
    .filter((descriptor) => {
      const descriptorProvider = normalizeProvider(descriptor.provider);
      return !provider || !descriptorProvider || descriptorProvider === normalizeProvider(provider);
    })
    .flatMap((descriptor) => [descriptor.id, ...(descriptor.aliases || [])])
    .filter(Boolean)
    .sort();
}

module.exports = {
  createCodeAssistModelDescriptorIndex,
  extractCodeAssistModelDescriptors,
  findCodeAssistModelRoute,
  listCodeAssistModelAliases,
  normalizeCodeAssistModelDescriptor,
  resolveCodeAssistModelDescriptor,
  resolveCodeAssistModelId,
  resolveCodeAssistUpstreamModel,
  resolveCodeAssistWireModelId,
  __private: {
    collectSourceDescriptors,
    normalizeProvider,
    readStringField,
    stripCodeAssistModelSuffix
  }
};
