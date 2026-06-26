const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function loadFilePreviewUtils() {
  const ts = require(path.join(__dirname, '..', 'web', 'node_modules', 'typescript'));
  const filePath = path.join(
    __dirname,
    '..',
    'web',
    'src',
    'components',
    'chat',
    'file-preview-utils.ts'
  );
  const source = fs.readFileSync(filePath, 'utf8');
  // Web 侧工具是 TypeScript，测试只加载纯函数，避免为一个小工具引入浏览器环境。
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020
    }
  });
  const moduleRef = { exports: {} };
  Function('module', 'exports', outputText)(moduleRef, moduleRef.exports);
  return moduleRef.exports;
}

test('file preview metadata recognizes common source languages', () => {
  const utils = loadFilePreviewUtils();

  assert.deepEqual(utils.getFilePreviewDescriptor('/repo/index.php'), {
    kind: 'source',
    extension: 'php',
    language: 'php',
    languageLabel: 'PHP',
    typeLabel: '源码'
  });
  assert.deepEqual(utils.getFilePreviewDescriptor('/repo/App.java'), {
    kind: 'source',
    extension: 'java',
    language: 'java',
    languageLabel: 'Java',
    typeLabel: '源码'
  });
  assert.equal(utils.getPreviewLanguageLabel('/repo/main.js'), 'JavaScript');
  assert.equal(utils.getPreviewLanguageLabel('/repo/widget.tsx'), 'React TSX');
  assert.deepEqual(utils.getPreviewModeOptions('source'), [
    { label: '原文', value: 'source' }
  ]);
});

test('file preview metadata keeps markdown and image modes distinct', () => {
  const utils = loadFilePreviewUtils();

  assert.deepEqual(utils.getFilePreviewDescriptor('/repo/README.md'), {
    kind: 'markdown',
    extension: 'md',
    language: 'markdown',
    languageLabel: 'Markdown',
    typeLabel: '文档'
  });
  assert.equal(utils.getDefaultPreviewMode('markdown'), 'rendered');
  assert.equal(utils.getDefaultPreviewMode('image'), 'image');
  assert.deepEqual(utils.getPreviewModeOptions('image'), [
    { label: '预览', value: 'image' },
    { label: '打开', value: 'source' }
  ]);
  assert.deepEqual(utils.getPreviewModeOptions('markdown'), [
    { label: '渲染', value: 'rendered' },
    { label: '原文', value: 'source' }
  ]);
});

test('file preview metadata handles special project files and media urls', () => {
  const utils = loadFilePreviewUtils();

  assert.equal(utils.getPreviewLanguage('/repo/Dockerfile'), 'dockerfile');
  assert.equal(utils.getPreviewLanguageLabel('/repo/.env.local'), 'ENV');
  assert.deepEqual(utils.getFilePreviewDescriptor('/repo/assets/logo.svg'), {
    kind: 'image',
    extension: 'svg',
    language: 'text',
    languageLabel: 'SVG',
    typeLabel: '图片'
  });
  assert.equal(
    utils.buildFileMediaUrl('/repo/assets/logo #1.svg', '/repo', 'claude'),
    '/v0/webui/fs/media?path=%2Frepo%2Fassets%2Flogo+%231.svg&projectPath=%2Frepo&source=claude'
  );
});

test('file preview metadata ignores line suffixes when detecting markdown files', () => {
  const utils = loadFilePreviewUtils();

  assert.deepEqual(utils.getFilePreviewDescriptor('/repo/docs/MEMORY.md:1080-1083'), {
    kind: 'markdown',
    extension: 'md',
    language: 'markdown',
    languageLabel: 'Markdown',
    typeLabel: '文档'
  });
  assert.equal(utils.getPreviewLanguageLabel('/repo/src/App.tsx:14'), 'React TSX');
});

test('file preview metadata treats MDX as rendered markdown with source fallback', () => {
  const utils = loadFilePreviewUtils();

  assert.deepEqual(utils.getFilePreviewDescriptor('/repo/docs/Page.mdx'), {
    kind: 'markdown',
    extension: 'mdx',
    language: 'markdown',
    languageLabel: 'MDX',
    typeLabel: '文档'
  });
  assert.equal(utils.getDefaultPreviewMode('markdown'), 'rendered');
  assert.deepEqual(utils.getPreviewModeOptions('markdown'), [
    { label: '渲染', value: 'rendered' },
    { label: '原文', value: 'source' }
  ]);
});

test('file-backed image urls share the file media route with preview drawer', () => {
  const utils = loadFilePreviewUtils();

  const first = utils.buildFileBackedImageUrl('/repo/screens/one.png', '/repo');
  const second = utils.buildFileBackedImageUrl('/repo/screens/two.png', '/repo');

  assert.equal(first, '/v0/webui/fs/media?path=%2Frepo%2Fscreens%2Fone.png&projectPath=%2Frepo');
  assert.equal(second, '/v0/webui/fs/media?path=%2Frepo%2Fscreens%2Ftwo.png&projectPath=%2Frepo');
  assert.notEqual(first, second);
  assert.equal(
    utils.buildFileBackedImageUrl('file:///repo/screens/%E4%B8%89.png', '/repo'),
    '/v0/webui/fs/media?path=%2Frepo%2Fscreens%2F%E4%B8%89.png&projectPath=%2Frepo'
  );
  assert.equal(
    utils.buildFileBackedImageUrl('/v0/webui/chat/attachments?path=tmp.png', '/repo'),
    '/v0/webui/chat/attachments?path=tmp.png'
  );
});
