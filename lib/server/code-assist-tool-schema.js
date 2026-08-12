'use strict';

/**
 * 工具 schema 在 code-assist 线路上的「可投递形状」。
 *
 * 背景：走 code-assist(agy/antigravity) 时，工具声明的 schema 被放进 Gemini Schema
 * proto 字段；如果目标模型是 Claude 家族，上游还会把这个 proto 再翻回 Anthropic 的
 * `input_schema`。这条往返链路比 JSON Schema 本身窄，实测有两类构造过不去：
 *
 * 1. `anyOf`：proto 收得下，但翻回 Anthropic 时产出非法 schema，上游直接 400
 *    `tools.N.custom.input_schema: JSON schema is invalid ...`。补一个同级 `type`
 *    也救不回来——错误一模一样，所以只能在发出前把联合类型折叠掉。
 * 2. 顶层空 schema：折叠/清洗后如果只剩 `{}`，上游报 `input_schema.type` 缺失。
 *
 * 这里只负责「把 schema 收敛成对面收得下的形状」，清洗（去 `$` 前缀、按 proto 白名单
 * 过滤）仍由 gemini-schema 负责，两件事分开。
 */

const { sanitizeSchemaForGemini } = require('./gemini-schema');

// 折叠联合类型后仍然可以保留的兄弟关键字。branch 合并只处理这些，
// 不去猜测跨分支的数值约束（min/max 等在不同分支上语义不同）。
const MERGEABLE_BRANCH_KEYS = ['properties', 'items', 'required', 'additionalProperties'];

function isSchemaObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readBranchType(branch) {
  return isSchemaObject(branch) && typeof branch.type === 'string' ? branch.type : '';
}

/**
 * 所有分支类型一致时返回该类型，否则返回空串。
 * 只要有一个分支没写 type，联合就是「不受约束」，同样返回空串——
 * 此时输出一个无 type 的节点，比强行挑一个分支的类型更少失真（无 type 上游是收的）。
 */
function resolveUnifiedBranchType(branches) {
  const types = branches.map(readBranchType);
  if (types.some((type) => !type)) return '';
  return types.every((type) => type === types[0]) ? types[0] : '';
}

/**
 * 合并各分支的 enum：只有每个分支都给了 enum，取值集合才是封闭的；
 * 只要有一个分支没有 enum，这个联合就允许该类型的任意值，必须整个丢掉 enum，
 * 否则会把合法取值（例如 TaskUpdate.status 的 `deleted`）误判成非法。
 */
function mergeBranchEnums(branches) {
  const enums = branches.map((branch) => (Array.isArray(branch.enum) ? branch.enum : null));
  if (enums.some((item) => !item)) return undefined;
  const merged = [];
  enums.forEach((item) => {
    item.forEach((value) => {
      if (!merged.includes(value)) merged.push(value);
    });
  });
  return merged.length > 0 ? merged : undefined;
}

function mergeBranchStructure(target, branches) {
  MERGEABLE_BRANCH_KEYS.forEach((key) => {
    if (key in target) return;
    const source = branches.find((branch) => branch[key] !== undefined);
    if (source) target[key] = source[key];
  });
}

/**
 * 把 `anyOf` 折叠进宿主节点。父节点自己写了的关键字优先，
 * 分支只补父节点没有的部分；`anyOf` 本身一定不会出现在输出里。
 */
function flattenUnionNode(node) {
  const branches = node.anyOf.filter(isSchemaObject);
  const flattened = { ...node };
  delete flattened.anyOf;

  if (branches.length === 0) return flattened;

  const unifiedType = resolveUnifiedBranchType(branches);
  // 分支类型不一致（string|number 这种）时不挑任何一个：留一个无 type 的节点，
  // 让模型按 description 填值，而不是被一个错误的类型限制住。
  if (unifiedType) {
    if (typeof flattened.type !== 'string') flattened.type = unifiedType;
  } else {
    delete flattened.type;
  }

  if (flattened.enum === undefined) {
    const mergedEnum = mergeBranchEnums(branches);
    if (mergedEnum) flattened.enum = mergedEnum;
  }
  mergeBranchStructure(flattened, branches);

  return flattened;
}

function flattenSchemaUnions(schema) {
  if (Array.isArray(schema)) return schema.map(flattenSchemaUnions);
  if (!isSchemaObject(schema)) return schema;

  const node = Array.isArray(schema.anyOf) ? flattenUnionNode(schema) : { ...schema };
  // 折叠后可能又露出一层 anyOf（分支自身带联合），继续压平到没有为止。
  if (Array.isArray(node.anyOf)) return flattenSchemaUnions(node);

  if (isSchemaObject(node.properties)) {
    const properties = {};
    Object.entries(node.properties).forEach(([name, value]) => {
      properties[name] = flattenSchemaUnions(value);
    });
    node.properties = properties;
  }
  if (node.items !== undefined) node.items = flattenSchemaUnions(node.items);
  if (isSchemaObject(node.additionalProperties)) {
    node.additionalProperties = flattenSchemaUnions(node.additionalProperties);
  }
  return node;
}

/**
 * 工具入参的根一定是对象。清洗后如果连 type 都没剩下（例如原 schema 只有 `$ref`），
 * 上游会拒绝 `input_schema.type`，所以这里补齐根类型。
 */
function ensureObjectRoot(schema) {
  const root = isSchemaObject(schema) ? schema : {};
  return typeof root.type === 'string' && root.type ? root : { ...root, type: 'object' };
}

/**
 * @param {object} schema 客户端给的原始 JSON Schema
 * @param {{ flattenUnions?: boolean }} [options] Claude 家族目标需要 flattenUnions
 */
function normalizeToolSchemaForCodeAssist(schema, options = {}) {
  const sanitized = sanitizeSchemaForGemini(schema);
  const projected = options.flattenUnions === true ? flattenSchemaUnions(sanitized) : sanitized;
  return ensureObjectRoot(projected);
}

module.exports = {
  normalizeToolSchemaForCodeAssist,
  __private: {
    ensureObjectRoot,
    flattenSchemaUnions
  }
};
