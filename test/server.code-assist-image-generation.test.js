'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isImageGenerationModel,
  applyImageGenerationGenerationConfig,
  extractInlineImageMarkdown,
  hasInlineImagePart
} = require('../lib/server/code-assist-image-generation');

// 图像生成模型(如 gemini-3.1-flash-image)把图片放在 inlineData(base64)part 里,
// 且必须显式开启 IMAGE 响应模态。这里覆盖模型识别、请求配置注入、响应解析三段行为。

test('isImageGenerationModel matches gemini image-generation models only', () => {
  assert.equal(isImageGenerationModel('gemini-3.1-flash-image'), true);
  assert.equal(isImageGenerationModel('GEMINI-3.1-FLASH-IMAGE'), true);
  assert.equal(isImageGenerationModel('gemini-2.5-flash-image'), true);
  assert.equal(isImageGenerationModel('nano-banana'), true);
  // image-input-capable *text* models must NOT be treated as image generators
  assert.equal(isImageGenerationModel('gemini-3.1-flash-lite'), false);
  assert.equal(isImageGenerationModel('gemini-3.1-pro-high'), false);
  assert.equal(isImageGenerationModel('claude-sonnet-4-6'), false);
  assert.equal(isImageGenerationModel(''), false);
  assert.equal(isImageGenerationModel(null), false);
});

test('applyImageGenerationGenerationConfig opts into IMAGE modality and drops thinking', () => {
  const cfg = { temperature: 1, thinkingConfig: { includeThoughts: true, thinkingBudget: -1 } };
  const out = applyImageGenerationGenerationConfig(cfg, 'gemini-3.1-flash-image');
  assert.deepEqual(out.responseModalities, ['TEXT', 'IMAGE']);
  assert.equal('thinkingConfig' in out, false);
  assert.equal(out.temperature, 1);
});

test('applyImageGenerationGenerationConfig leaves non-image models untouched', () => {
  const cfg = { temperature: 1, thinkingConfig: { thinkingBudget: 1024 } };
  const out = applyImageGenerationGenerationConfig(cfg, 'gemini-3.1-pro-high');
  assert.equal('responseModalities' in out, false);
  assert.deepEqual(out.thinkingConfig, { thinkingBudget: 1024 });
});

test('extractInlineImageMarkdown renders inlineData parts as markdown data URLs', () => {
  const parts = [
    { text: 'ignored text' },
    { inlineData: { mimeType: 'image/jpeg', data: 'QUJD' } },
    { inline_data: { mime_type: 'image/png', data: 'REVG' } }
  ];
  const md = extractInlineImageMarkdown(parts);
  assert.equal(
    md,
    '![生成的图片](data:image/jpeg;base64,QUJD)\n\n![生成的图片](data:image/png;base64,REVG)'
  );
});

test('extractInlineImageMarkdown defaults mime type and honours custom alt', () => {
  const md = extractInlineImageMarkdown([{ inlineData: { data: 'QUJD' } }], { alt: 'pic' });
  assert.equal(md, '![pic](data:image/png;base64,QUJD)');
});

test('extractInlineImageMarkdown returns empty string when no image parts', () => {
  assert.equal(extractInlineImageMarkdown([{ text: 'hi' }]), '');
  assert.equal(extractInlineImageMarkdown([]), '');
  assert.equal(extractInlineImageMarkdown(null), '');
});

test('hasInlineImagePart detects presence of inlineData parts', () => {
  assert.equal(hasInlineImagePart([{ inlineData: { data: 'QUJD' } }]), true);
  assert.equal(hasInlineImagePart([{ inlineData: { data: '' } }]), false);
  assert.equal(hasInlineImagePart([{ text: 'hi' }]), false);
});
