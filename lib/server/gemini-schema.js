'use strict';

const GEMINI_SCHEMA_SCALAR_KEYS = new Set([
  'type',
  'format',
  'title',
  'description',
  'nullable',
  'enum',
  'required',
  'minimum',
  'maximum',
  'minItems',
  'maxItems',
  'minLength',
  'maxLength',
  'minProperties',
  'maxProperties',
  'pattern',
  'example',
  'default',
  'propertyOrdering'
]);

function normalizeSchemaType(value) {
  if (!Array.isArray(value)) return value;
  const types = value
    .map((item) => String(item || '').trim())
    .filter((item) => item && item.toLowerCase() !== 'null');
  return types[0] || 'string';
}

function sanitizeStringArray(value) {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .map((item) => String(item || '').trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

// Gemini Schema proto 的 enum 是 `repeated string`：塞进数字/布尔值上游会在解析阶段
// 直接拒绝（`Invalid value at ...parameters.properties[N].value.enum[0] (TYPE_STRING)`）。
// 数字枚举转成字符串又会和 `type: integer` 自相矛盾，所以这里的取舍是：
// 全是字符串就保留，出现非字符串就整条 enum 丢掉——少一个取值约束，
// 好过整个请求发不出去。
function sanitizeEnum(value) {
  if (!Array.isArray(value)) return undefined;
  if (value.some((item) => typeof item !== 'string')) return undefined;
  const items = value.map((item) => item.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function sanitizeProperties(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const properties = {};
  Object.entries(value).forEach(([propertyName, propertySchema]) => {
    const sanitized = sanitizeSchemaForGemini(propertySchema);
    if (sanitized && typeof sanitized === 'object' && Object.keys(sanitized).length > 0) {
      properties[propertyName] = sanitized;
    }
  });
  return Object.keys(properties).length > 0 ? properties : undefined;
}

function sanitizeSchemaArray(value) {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .map((item) => sanitizeSchemaForGemini(item))
    .filter((item) => item && typeof item === 'object' && Object.keys(item).length > 0);
  return items.length > 0 ? items : undefined;
}

function sanitizeAdditionalProperties(value) {
  if (typeof value === 'boolean') return value;
  if (!value || typeof value !== 'object') return undefined;
  const sanitized = sanitizeSchemaForGemini(value);
  return sanitized && Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function sanitizeSchemaForGemini(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) {
    const tupleItems = sanitizeSchemaArray(schema);
    return tupleItems && tupleItems[0] ? tupleItems[0] : {};
  }

  const result = {};
  Object.entries(schema).forEach(([key, value]) => {
    if (!key || key.startsWith('$')) return;

    if (key === 'type') {
      result.type = normalizeSchemaType(value);
      return;
    }
    if (key === 'properties') {
      const properties = sanitizeProperties(value);
      if (properties) result.properties = properties;
      return;
    }
    if (key === 'items') {
      const sanitized = sanitizeSchemaForGemini(value);
      if (sanitized && typeof sanitized === 'object' && Object.keys(sanitized).length > 0) {
        result.items = sanitized;
      }
      return;
    }
    if (key === 'additionalProperties') {
      const sanitized = sanitizeAdditionalProperties(value);
      if (sanitized !== undefined) result.additionalProperties = sanitized;
      return;
    }
    if (key === 'anyOf') {
      const sanitized = sanitizeSchemaArray(value);
      if (sanitized) result.anyOf = sanitized;
      return;
    }
    if (!GEMINI_SCHEMA_SCALAR_KEYS.has(key)) return;

    if (key === 'required' || key === 'propertyOrdering') {
      const items = sanitizeStringArray(value);
      if (items) result[key] = items;
      return;
    }
    if (key === 'enum') {
      const items = sanitizeEnum(value);
      if (items) result.enum = items;
      return;
    }
    result[key] = value;
  });

  return result;
}

module.exports = {
  sanitizeSchemaForGemini
};
