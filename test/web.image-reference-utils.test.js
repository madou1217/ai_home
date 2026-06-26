const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function loadImageReferenceUtils() {
  const ts = require(path.join(__dirname, '..', 'web', 'node_modules', 'typescript'));
  const filePath = path.join(
    __dirname,
    '..',
    'web',
    'src',
    'components',
    'chat',
    'image-reference-utils.ts'
  );
  const source = fs.readFileSync(filePath, 'utf8');
  // 该工具不依赖 DOM，直接转译成 CommonJS 测纯函数，避免引入 React 测试环境。
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

test('single image tool result keeps global image number alignment', () => {
  const utils = loadImageReferenceUtils();

  const images = utils.buildSingleImageReferenceSourceList(
    '[Image #3]',
    '/v0/webui/fs/media?path=third.png',
    ['inline-one', 'inline-two', 'inline-third']
  );
  assert.deepEqual(images, [
    '',
    '',
    {
      src: '/v0/webui/fs/media?path=third.png',
      fallbackSrc: 'inline-third'
    }
  ]);

  const segments = utils.splitImageReferenceText('[Image #3]', images);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].type, 'image_reference');
  assert.equal(segments[0].src, '/v0/webui/fs/media?path=third.png');
  assert.equal(segments[0].fallbackSrc, 'inline-third');
});

test('single image tool result falls back to first slot without a marker', () => {
  const utils = loadImageReferenceUtils();

  assert.deepEqual(
    utils.buildSingleImageReferenceSourceList('图片读取完成', '/v0/webui/fs/media?path=one.png', ['inline-one']),
    [{ src: '/v0/webui/fs/media?path=one.png', fallbackSrc: 'inline-one' }]
  );
});

test('single image tool result can use path-scoped fallback for repeated local image markers', () => {
  const utils = loadImageReferenceUtils();

  const first = utils.buildSingleImageReferenceSourceList(
    '[Image #1]',
    '/v0/webui/fs/media?path=first.png',
    ['message-first', 'message-second'],
    'path-first'
  );
  const second = utils.buildSingleImageReferenceSourceList(
    '[Image #1]',
    '/v0/webui/fs/media?path=second.png',
    ['message-first', 'message-second'],
    'path-second'
  );

  assert.deepEqual(first, [{ src: '/v0/webui/fs/media?path=first.png', fallbackSrc: 'path-first' }]);
  assert.deepEqual(second, [{ src: '/v0/webui/fs/media?path=second.png', fallbackSrc: 'path-second' }]);
});

test('file-backed image result does not reuse message indexed fallback when path fallback is absent', () => {
  const utils = loadImageReferenceUtils();

  const images = utils.buildSingleImageReferenceSourceList(
    '[Image #1]',
    '/v0/webui/fs/media?path=second.png',
    ['message-first'],
    {
      allowIndexedFallback: false
    }
  );

  assert.deepEqual(images, [{ src: '/v0/webui/fs/media?path=second.png', fallbackSrc: '' }]);
});

test('file-backed image result still keeps global image marker slot without indexed fallback', () => {
  const utils = loadImageReferenceUtils();

  const images = utils.buildSingleImageReferenceSourceList(
    '[Image #3]',
    '/v0/webui/fs/media?path=third.png',
    ['message-first', 'message-second', 'message-third'],
    {
      fallbackSource: 'path-third',
      allowIndexedFallback: false
    }
  );

  assert.deepEqual(images, [
    '',
    '',
    {
      src: '/v0/webui/fs/media?path=third.png',
      fallbackSrc: 'path-third'
    }
  ]);
});

test('path-scoped fallbacks follow image tool order when every result uses Image #1', () => {
  const utils = loadImageReferenceUtils();

  const fallbackMap = utils.buildPathScopedImageFallbackMap([
    { path: '/repo/App.tsx', isImage: false },
    { path: '/repo/final-desktop-dashboard.png', isImage: true },
    { path: '/repo/final-desktop-accounts.png', isImage: true },
    { path: '/repo/final-desktop-design.png', isImage: true }
  ], ['dashboard-data', 'accounts-data', 'design-data']);

  assert.deepEqual(fallbackMap, {
    '/repo/final-desktop-dashboard.png': 'dashboard-data',
    '/repo/final-desktop-accounts.png': 'accounts-data',
    '/repo/final-desktop-design.png': 'design-data'
  });
});

test('path-scoped fallbacks keep first binding for duplicate image paths without shifting later images', () => {
  const utils = loadImageReferenceUtils();

  const fallbackMap = utils.buildPathScopedImageFallbackMap([
    { path: '/repo/repeated.png', isImage: true },
    { path: '/repo/repeated.png', isImage: true },
    { path: '/repo/next.png', isImage: true }
  ], ['first-read', 'second-read', 'next-read']);

  assert.deepEqual(fallbackMap, {
    '/repo/repeated.png': 'first-read',
    '/repo/next.png': 'next-read'
  });
});

test('image reference splitting still accepts plain string image lists', () => {
  const utils = loadImageReferenceUtils();

  const segments = utils.splitImageReferenceText('[Image #1]', ['data:image/png;base64,one']);

  assert.equal(segments[0].type, 'image_reference');
  assert.equal(segments[0].src, 'data:image/png;base64,one');
  assert.equal(segments[0].fallbackSrc, '');
});
