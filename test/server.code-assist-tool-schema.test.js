const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeToolSchemaForCodeAssist
} = require('../lib/server/code-assist-tool-schema');
const {
  normalizeAnthropicToolsForCodeAssist
} = require('../lib/server/code-assist-anthropic-adapter').__private;
const {
  resolveCodeAssistProviderStrategy,
  isClaudeFamilyModel
} = require('../lib/server/code-assist-provider-strategy');

// 实测：Claude 家族目标带 anyOf 会被上游拒成
// `tools.N.custom.input_schema: JSON schema is invalid`，补同级 type 也无效。
test('normalizeToolSchemaForCodeAssist removes anyOf for claude targets', () => {
  const schema = {
    type: 'object',
    properties: {
      status: {
        description: 'New status',
        anyOf: [
          { type: 'string', enum: ['pending', 'completed'] },
          { type: 'string', const: 'deleted' }
        ]
      }
    }
  };

  const normalized = normalizeToolSchemaForCodeAssist(schema, { flattenUnions: true });

  assert.equal(JSON.stringify(normalized).includes('anyOf'), false);
  assert.equal(normalized.properties.status.type, 'string');
  assert.equal(normalized.properties.status.description, 'New status');
});

// 分支间有一个没给 enum 就说明该类型的任意值都合法。保留另一分支的 enum 会把
// `deleted` 这类取值判成非法——把工具从「报错」降级成「用不了」，等于没修。
test('normalizeToolSchemaForCodeAssist drops enum when a union branch is unconstrained', () => {
  const normalized = normalizeToolSchemaForCodeAssist({
    type: 'object',
    properties: {
      status: {
        anyOf: [
          { type: 'string', enum: ['pending', 'completed'] },
          { type: 'string' }
        ]
      }
    }
  }, { flattenUnions: true });

  assert.equal(normalized.properties.status.enum, undefined);
});

test('normalizeToolSchemaForCodeAssist unions enums when every branch constrains them', () => {
  const normalized = normalizeToolSchemaForCodeAssist({
    type: 'object',
    properties: {
      mode: {
        anyOf: [
          { type: 'string', enum: ['fast'] },
          { type: 'string', enum: ['slow', 'fast'] }
        ]
      }
    }
  }, { flattenUnions: true });

  assert.deepEqual(normalized.properties.mode.enum, ['fast', 'slow']);
});

// 分支类型不一致时挑任何一个都是错的；无 type 的节点上游收得下，失真更小。
test('normalizeToolSchemaForCodeAssist leaves heterogeneous unions untyped', () => {
  const normalized = normalizeToolSchemaForCodeAssist({
    type: 'object',
    properties: {
      value: {
        description: 'string or number',
        anyOf: [{ type: 'string' }, { type: 'number' }]
      }
    }
  }, { flattenUnions: true });

  assert.equal(normalized.properties.value.type, undefined);
  assert.equal(normalized.properties.value.description, 'string or number');
});

test('normalizeToolSchemaForCodeAssist flattens unions nested in array items', () => {
  const normalized = normalizeToolSchemaForCodeAssist({
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: { anyOf: [{ type: 'string' }, { type: 'string', enum: ['a'] }] }
      }
    }
  }, { flattenUnions: true });

  assert.equal(JSON.stringify(normalized).includes('anyOf'), false);
  assert.equal(normalized.properties.items.items.type, 'string');
});

// `$ref` 会被清洗掉，只剩空 schema；上游对空 schema 报 `input_schema.type`。
test('normalizeToolSchemaForCodeAssist always yields an object root', () => {
  assert.deepEqual(normalizeToolSchemaForCodeAssist({ $ref: '#/$defs/X' }, { flattenUnions: true }), { type: 'object' });
  assert.deepEqual(normalizeToolSchemaForCodeAssist(null, { flattenUnions: true }), { type: 'object' });
});

// 非 Claude 目标不折叠：Gemini 自己支持 anyOf，折叠只会白白丢表达力。
test('normalizeToolSchemaForCodeAssist keeps anyOf when flattening is not requested', () => {
  const normalized = normalizeToolSchemaForCodeAssist({
    type: 'object',
    properties: { value: { anyOf: [{ type: 'string' }, { type: 'number' }] } }
  });

  assert.equal(Array.isArray(normalized.properties.value.anyOf), true);
});

// Gemini Schema proto 的 enum 是 repeated string，数字枚举上游直接拒收。
test('normalizeToolSchemaForCodeAssist drops non-string enums the proto rejects', () => {
  const normalized = normalizeToolSchemaForCodeAssist({
    type: 'object',
    properties: { count: { type: 'integer', enum: [1, 2, 3], description: 'count' } }
  }, { flattenUnions: true });

  assert.equal(normalized.properties.count.enum, undefined);
  assert.equal(normalized.properties.count.type, 'integer');
  assert.equal(normalized.properties.count.description, 'count');
});

test('isClaudeFamilyModel recognises claude and anthropic model ids', () => {
  assert.equal(isClaudeFamilyModel('claude-opus-4-6-thinking'), true);
  assert.equal(isClaudeFamilyModel('us.anthropic.claude-sonnet'), true);
  assert.equal(isClaudeFamilyModel('gemini-3-flash'), false);
  assert.equal(isClaudeFamilyModel(''), false);
});

// 回归：TaskUpdate 曾被按名字整个摘掉来绕开这个 400，工具因此在 agy 上凭空消失。
test('normalizeAnthropicToolsForCodeAssist keeps union-typed tools instead of dropping them', () => {
  const strategy = resolveCodeAssistProviderStrategy('agy');
  assert.deepEqual([...(strategy.anthropicExcludedToolNames || [])], []);

  const declarations = normalizeAnthropicToolsForCodeAssist(
    [{
      name: 'TaskUpdate',
      input_schema: {
        type: 'object',
        properties: { status: { anyOf: [{ type: 'string', enum: ['pending'] }, { type: 'string' }] } }
      }
    }],
    'parameters',
    undefined,
    { excludedToolNames: strategy.anthropicExcludedToolNames, flattenSchemaUnions: true }
  );

  assert.equal(declarations.length, 1);
  assert.equal(declarations[0].name, 'TaskUpdate');
  assert.equal(JSON.stringify(declarations[0].parameters).includes('anyOf'), false);
});
