'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  projectHarnessModelMetadata
} = require('../lib/server/chat-runtime/chat-harness-model-metadata');

const model = {
  model: 'claude-opus-4-6-thinking',
  displayName: 'Claude Opus 4.6 Thinking',
  defaultReasoningEffort: 'high',
  supportedReasoningEfforts: ['high']
};

test('harness model metadata honors catalog-declared modalities', () => {
  const projected = projectHarnessModelMetadata(model, {
    name: 'Claude Opus 4.6',
    modalities: { input: ['text', 'image', 'pdf'] }
  });
  // pdf/video 超出 harness 输入通道，只有 text/image 会透传给 codex 模型目录
  assert.deepEqual(projected.input_modalities, ['text', 'image']);
});

test('harness model metadata keeps known text-only models text-only', () => {
  const projected = projectHarnessModelMetadata(
    { ...model, model: 'gpt-oss-120b-medium' },
    { modalities: { input: ['text'] } }
  );
  assert.deepEqual(projected.input_modalities, ['text']);
});

test('harness model metadata fails open to text+image for catalog-unknown models', () => {
  // provider 自定义 id（后缀变体/私有重命名）查不到目录条目时若默认 text-only，
  // harness 会在本地拦掉用户显式附加的图片与视频关键帧；放行由网关裁决。
  const projected = projectHarnessModelMetadata({ ...model, model: 'gemini-pro-agent' }, {});
  assert.deepEqual(projected.input_modalities, ['text', 'image']);
});
