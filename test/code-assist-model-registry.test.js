const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  extractCodeAssistModelDescriptors,
  listCodeAssistModelAliases,
  resolveCodeAssistModelDescriptor,
  resolveCodeAssistModelId,
  resolveCodeAssistUpstreamModel,
  resolveCodeAssistWireModelId
} = require('../lib/server/code-assist-model-registry');

test('code assist model registry resolves public and wire ids from provider descriptors', () => {
  const descriptors = extractCodeAssistModelDescriptors('agy', {
    models: {
      public_model: {
        displayName: 'Public Model',
        model: 'public-model',
        wireModelId: 'wire-model',
        deprecatedModelIds: {
          legacy_model: { replacement: 'public-model' }
        }
      }
    }
  });

  assert.deepEqual(descriptors.map((item) => [item.id, item.wireId]), [
    ['public-model', 'wire-model']
  ]);
  assert.equal(resolveCodeAssistModelId('agy', 'Public Model', { descriptors }), 'public-model');
  assert.equal(resolveCodeAssistWireModelId('agy', 'Public Model', { descriptors }), 'wire-model');
  assert.equal(resolveCodeAssistUpstreamModel('agy', 'legacy_model', { descriptors }), 'wire-model');
});

test('code assist model registry forwards top-level deprecatedModelIds to the agent wire model (agy 400 root cause)', () => {
  // antigravity fetchAvailableModels 顶层 deprecatedModelIds 形如 {"gemini-3.1-pro-high":"gemini-pro-agent"}。
  // 修复前转发表被忽略 → 旧 id 原样发往 agent 端点 → INVALID_ARGUMENT(400)。
  // 真实情况：废弃模型 gemini-3.1-pro-high **仍作为独立可用模型**出现在 models 里（会遮蔽别名），
  // 同时出现在 deprecatedModelIds。修复必须把它自身的 wire 重定向到 gemini-pro-agent。
  const payload = {
    models: [{ model: 'gemini-3.1-pro-high' }, { model: 'gemini-pro-agent' }, { model: 'gemini-3-flash-agent' }],
    deprecatedModelIds: { 'gemini-3.1-pro-high': 'gemini-pro-agent' }
  };
  const descriptors = extractCodeAssistModelDescriptors('agy', payload);
  // 请求被废弃的展示模型 → 实际发往真实 agent wire 模型（即使它自己也是一个描述符）
  assert.equal(resolveCodeAssistWireModelId('agy', 'gemini-3.1-pro-high', { descriptors }), 'gemini-pro-agent');
  // 经 cache round-trip（cacheCodeAssistModelDescriptors 用 {models} 重新抽取）后仍生效
  const recached = extractCodeAssistModelDescriptors('agy', { models: descriptors });
  assert.equal(resolveCodeAssistWireModelId('agy', 'gemini-3.1-pro-high', { descriptors: recached }), 'gemini-pro-agent');
  // 直接请求 agent 模型不受影响
  assert.equal(resolveCodeAssistWireModelId('agy', 'gemini-pro-agent', { descriptors }), 'gemini-pro-agent');

  // 对象形态 {newModelId} 也支持
  const payload2 = {
    models: [{ model: 'gemini-pro-agent' }],
    deprecatedModelIds: { 'gemini-3.1-pro-high': { newModelId: 'gemini-pro-agent' } }
  };
  const descriptors2 = extractCodeAssistModelDescriptors('agy', payload2);
  assert.equal(resolveCodeAssistWireModelId('agy', 'gemini-3.1-pro-high', { descriptors: descriptors2 }), 'gemini-pro-agent');
});

test('code assist model registry falls back to the requested id without descriptor data', () => {
  assert.equal(resolveCodeAssistModelId('agy', 'unknown-model'), 'unknown-model');
  assert.equal(resolveCodeAssistWireModelId('agy', 'unknown-model'), 'unknown-model');
  assert.deepEqual(listCodeAssistModelAliases('agy'), []);
});

test('code assist model registry parses quota bucket ids without provider-specific mappings', () => {
  const descriptors = extractCodeAssistModelDescriptors('gemini', {
    buckets: [
      { modelId: 'quota-model_vertex' },
      { modelId: 'another-model' }
    ]
  });

  assert.deepEqual(descriptors.map((item) => item.id), ['another-model', 'quota-model']);
  assert.equal(resolveCodeAssistModelDescriptor('gemini', 'quota-model', { descriptors }).wireId, 'quota-model');
});

test('code assist model registry never exposes internal enum ids as public catalog models', () => {
  const descriptors = extractCodeAssistModelDescriptors('agy', {
    models: [
      { model: 'MODEL_INTERNAL_ALPHA' },
      { model: 'MODEL_INTERNAL_BETA', displayName: 'Catalog Public Model' },
      'provider-public-agent'
    ]
  });

  assert.deepEqual(descriptors.map((item) => item.id), [
    'provider-public-agent'
  ]);
  assert.equal(resolveCodeAssistModelDescriptor('agy', 'catalog-public-model', { descriptors }), null);
  assert.equal(resolveCodeAssistModelDescriptor('agy', 'MODEL_INTERNAL_BETA', { descriptors }), null);
  assert.equal(resolveCodeAssistModelDescriptor('agy', 'MODEL_INTERNAL_ALPHA', { descriptors }), null);
});

test('code assist model registry resolves version separator variants from descriptors', () => {
  const descriptors = extractCodeAssistModelDescriptors('agy', {
    models: [{
      model: 'provider-family-4-6-mode',
      wireModelId: 'provider-family-4-6-mode'
    }]
  });

  const descriptor = resolveCodeAssistModelDescriptor('agy', 'provider-family-4.6-mode', { descriptors });
  assert.equal(descriptor.id, 'provider-family-4-6-mode');
  assert.equal(resolveCodeAssistWireModelId('agy', 'provider-family-4.6-mode', { descriptors }), 'provider-family-4-6-mode');
});

test('code assist model registry promotes tieredModelIds to standalone catalog descriptors', () => {
  const descriptors = extractCodeAssistModelDescriptors('agy', {
    models: {
      'gemini-3.5-flash': {
        displayName: 'Gemini 3.5 Flash',
        tieredModelIds: {
          low: 'gemini-3.5-flash-low',
          high: 'gemini-3.5-flash-high'
        }
      }
    }
  });

  // 档位模型必须成为独立目录模型,而不是父 descriptor 的 alias
  assert.deepEqual(descriptors.map((item) => item.id).sort(), [
    'gemini-3.5-flash',
    'gemini-3.5-flash-high',
    'gemini-3.5-flash-low'
  ]);
  const high = descriptors.find((item) => item.id === 'gemini-3.5-flash-high');
  assert.equal(high.wireId, 'gemini-3.5-flash-high');
  const parent = descriptors.find((item) => item.id === 'gemini-3.5-flash');
  assert.equal(parent.aliases.includes('gemini-3.5-flash-high'), false);
});

test('code assist model registry promotes tiered ids from array form and filters tier labels', () => {
  const descriptors = extractCodeAssistModelDescriptors('agy', {
    models: {
      'gemini-3.5-flash-low': {
        displayName: 'Gemini 3.5 Flash Low',
        tieredModelIds: ['gemini-3.5-flash-low', 'gemini-3.5-flash-high', 'MODEL_INTERNAL_TIER']
      }
    }
  });

  assert.deepEqual(descriptors.map((item) => item.id).sort(), [
    'gemini-3.5-flash-high',
    'gemini-3.5-flash-low'
  ]);
});

test('code assist model registry keeps deprecated ids as aliases not catalog models', () => {
  const descriptors = extractCodeAssistModelDescriptors('agy', {
    models: {
      'claude-sonnet-4-6': {
        displayName: 'Claude Sonnet',
        deprecatedModelIds: ['claude-sonnet-4-5']
      }
    }
  });

  assert.deepEqual(descriptors.map((item) => item.id), ['claude-sonnet-4-6']);
  const descriptor = descriptors[0];
  assert.equal(descriptor.aliases.includes('claude-sonnet-4-5'), true);
});

test('code assist model registry falls back to the models map key when inner model field is an internal enum', () => {
  // 真实 Antigravity 负载形状:models.* 的 model 字段是 MODEL_PLACEHOLDER_* 内部枚举
  const descriptors = extractCodeAssistModelDescriptors('agy', {
    models: {
      'gemini-3.1-pro-high': {
        displayName: 'Gemini 3.1 Pro (High)',
        model: 'MODEL_PLACEHOLDER_M37',
        quotaInfo: { remainingFraction: 1 }
      },
      'gemini-2.5-flash': {
        displayName: 'Gemini 3.1 Flash Lite',
        model: 'MODEL_GOOGLE_GEMINI_2_5_FLASH',
        quotaInfo: { remainingFraction: 1 }
      },
      chat_20706: { quotaInfo: { remainingFraction: 1 } },
      tab_flash_lite_preview: { quotaInfo: { remainingFraction: 1 } }
    },
    deprecatedModelIds: {
      'gemini-3.1-pro-high': { newModelId: 'gemini-pro-agent', oldModelEnum: 'MODEL_PLACEHOLDER_M37' }
    },
    agentModelSorts: [{ groups: [{ modelIds: ['gemini-2.5-flash'] }] }]
  });

  assert.deepEqual(descriptors.map((item) => item.id).sort(), [
    'gemini-2.5-flash',
    'gemini-3.1-pro-high'
  ]);
  const high = descriptors.find((item) => item.id === 'gemini-3.1-pro-high');
  // wire id 不允许是内部枚举,回退到真实模型键
  assert.equal(high.wireId, 'gemini-3.1-pro-high');
});

test('code assist model registry still prefers real inner model ids over the map key', () => {
  const descriptors = extractCodeAssistModelDescriptors('agy', {
    models: {
      public_model: {
        model: 'public-model',
        wireModelId: 'wire-model'
      }
    }
  });
  assert.deepEqual(descriptors.map((item) => [item.id, item.wireId]), [
    ['public-model', 'wire-model']
  ]);
});

test('code assist model registry never uses vertexModelId as the wire id', () => {
  // 真实回归:vertexModelId(claude-opus-4-6@default)是 Vertex 内部版本 id,
  // 发给 cloudcode 会 404,wire 必须回退到公开模型 id(models 容器键)。
  const descriptors = extractCodeAssistModelDescriptors('agy', {
    models: {
      'claude-opus-4-6-thinking': {
        displayName: 'Claude Opus 4.6 (Thinking)',
        model: 'MODEL_PLACEHOLDER_M26',
        vertexModelId: 'claude-opus-4-6@default',
        quotaInfo: { remainingFraction: 1 }
      }
    }
  });

  assert.deepEqual(descriptors.map((item) => [item.id, item.wireId]), [
    ['claude-opus-4-6-thinking', 'claude-opus-4-6-thinking']
  ]);
  assert.equal(
    resolveCodeAssistWireModelId('agy', 'claude-opus-4-6-thinking', { descriptors }),
    'claude-opus-4-6-thinking'
  );
});
