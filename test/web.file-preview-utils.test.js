const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function loadTypeScriptModule(...relativePath) {
  const ts = require(path.join(__dirname, '..', 'web', 'node_modules', 'typescript'));
  const filePath = path.join(__dirname, '..', ...relativePath);
  const source = fs.readFileSync(filePath, 'utf8');
  // Web 侧工具是 TypeScript，测试只加载纯函数，避免为小工具引入浏览器环境。
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020
    }
  });
  const moduleRef = { exports: {} };
  const requireFromPreviewUtils = (request) => {
    throw new Error(`Unexpected file preview dependency: ${request}`);
  };
  Function('module', 'exports', 'require', outputText)(
    moduleRef,
    moduleRef.exports,
    requireFromPreviewUtils
  );
  return moduleRef.exports;
}

function loadFilePreviewUtils() {
  return loadTypeScriptModule('web', 'src', 'components', 'chat', 'file-preview-utils.ts');
}

function loadHtmlPreviewWindow() {
  return loadTypeScriptModule('web', 'src', 'components', 'chat', 'html-preview-window.ts');
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

test('file preview metadata treats HTML documents as rendered previews with source fallback', () => {
  const utils = loadFilePreviewUtils();

  for (const extension of ['html', 'htm', 'xhtml']) {
    assert.deepEqual(utils.getFilePreviewDescriptor(`/repo/page.${extension}`), {
      kind: 'html',
      extension,
      language: 'html',
      languageLabel: 'HTML',
      typeLabel: '网页'
    });
  }
  assert.equal(utils.getDefaultPreviewMode('html'), 'rendered');
  assert.deepEqual(utils.getPreviewModeOptions('html'), [
    { label: '预览', value: 'rendered' },
    { label: '原文', value: 'source' }
  ]);
});

test('normalized HTML preview documents preserve scripts and external assets', () => {
  const utils = loadFilePreviewUtils();
  const document = '<!doctype html><html lang="zh-CN"><head><title>Demo</title><script src="https://cdn.example/app.js"></script></head><body><script>window.render()</script></body></html>';
  const normalized = utils.normalizeHtmlPreviewDocument(document);

  assert.ok(normalized.startsWith('<!doctype html>'));
  assert.match(normalized, /<head><meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.ok(normalized.indexOf('name="viewport"') < normalized.indexOf('<title>'));
  assert.match(normalized, /<script src="https:\/\/cdn\.example\/app\.js"><\/script>/);
  assert.match(normalized, /<script>window\.render\(\)<\/script>/);
  assert.doesNotMatch(normalized, /Content-Security-Policy/);
});

test('normalized HTML preview documents add a head or wrap fragments without dropping content', () => {
  const utils = loadFilePreviewUtils();
  const withoutHead = utils.normalizeHtmlPreviewDocument('<html><body><h1>No head</h1></body></html>');
  const fragment = '<main class="card"><h1>Fragment</h1></main>';
  const wrappedFragment = utils.normalizeHtmlPreviewDocument(fragment);
  const wrappedDoctypeFragment = utils.normalizeHtmlPreviewDocument(`<!DOCTYPE html>${fragment}`);

  assert.match(withoutHead, /^<html><head><meta name="viewport"[\s\S]*<\/head><body>/);
  assert.match(wrappedFragment, /^<!doctype html><html><head><meta name="viewport"/);
  assert.ok(wrappedFragment.endsWith(`<body>${fragment}</body></html>`));
  assert.equal((wrappedDoctypeFragment.match(/<!doctype html>/gi) || []).length, 1);
  assert.ok(wrappedDoctypeFragment.endsWith(`<body>${fragment}</body></html>`));
});

test('HTML preview window supports PC and mobile viewports in an isolated iframe', () => {
  const preview = loadHtmlPreviewWindow();
  const shell = preview.buildHtmlPreviewWindowDocument(
    '<button onclick="window.render()">Render</button>',
    { device: 'mobile', title: 'Demo "page"' }
  );

  assert.match(shell, /data-device="mobile"/);
  assert.match(shell, /sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads"/);
  assert.match(shell, /referrerpolicy="no-referrer"/);
  assert.match(shell, />PC 预览</);
  assert.match(shell, />手机预览</);
  assert.match(shell, /data-fullscreen/);
  assert.match(shell, />全屏</);
  assert.match(shell, /preview\.requestFullscreen\(\)/);
  assert.match(shell, /\.preview:fullscreen/);
  assert.match(shell, /srcdoc="&lt;button onclick=&quot;window\.render\(\)&quot;&gt;Render&lt;\/button&gt;"/);
  assert.doesNotMatch(shell, /allow-same-origin|allow-top-navigation/);
  assert.doesNotMatch(shell, /Content-Security-Policy/);
});

test('HTML preview drawer launches PC and mobile previews instead of embedding the document', () => {
  const componentPath = path.join(
    __dirname,
    '..',
    'web',
    'src',
    'components',
    'chat',
    'FilePreviewPane.tsx'
  );
  const source = fs.readFileSync(componentPath, 'utf8');

  assert.match(source, /openHtmlPreviewWindow/);
  assert.match(source, />PC 预览</);
  assert.match(source, />手机预览</);
  assert.match(source, />刷新</);
  assert.doesNotMatch(source, /<iframe/);
});

test('file preview drawer drops loaded snapshots when it closes', () => {
  const componentPath = path.join(
    __dirname,
    '..',
    'web',
    'src',
    'components',
    'chat',
    'FileDrawer.tsx'
  );
  const source = fs.readFileSync(componentPath, 'utf8');

  assert.match(source, /if \(open\) return;[\s\S]*activeRequests\.current = \{\};[\s\S]*setPreviewState\(\{\}\)/);
  assert.match(source, /onReload=\{\(\) => void loadPreview\(tab\)\}/);
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

test('markdown local images use authorized media urls in message and file preview contexts', () => {
  const utils = loadFilePreviewUtils();

  assert.equal(
    utils.buildMarkdownImageSource('file:///Users/model/.gemini/brain/phoenix%20concert.jpg', {
      projectPath: '/repo'
    }),
    '/v0/webui/fs/media?path=%2FUsers%2Fmodel%2F.gemini%2Fbrain%2Fphoenix+concert.jpg&projectPath=%2Frepo'
  );
  assert.equal(
    utils.buildMarkdownImageSource('/Users/model/.claude/artifacts/chart.png', {
      projectPath: '/repo'
    }),
    '/v0/webui/fs/media?path=%2FUsers%2Fmodel%2F.claude%2Fartifacts%2Fchart.png&projectPath=%2Frepo'
  );
  assert.equal(
    utils.buildMarkdownImageSource('/Users/model/.claude/artifacts/encoded%20chart.png', {
      projectPath: '/repo'
    }),
    '/v0/webui/fs/media?path=%2FUsers%2Fmodel%2F.claude%2Fartifacts%2Fencoded+chart.png&projectPath=%2Frepo'
  );
  assert.equal(
    utils.buildMarkdownImageSource('./artifacts/chart.png', {
      baseDirectory: '/repo',
      projectPath: '/repo'
    }),
    '/v0/webui/fs/media?path=%2Frepo%2Fartifacts%2Fchart.png&projectPath=%2Frepo'
  );
  assert.equal(
    utils.buildMarkdownImageSource('./artifacts/encoded%20chart.png', {
      baseDirectory: '/repo',
      projectPath: '/repo'
    }),
    '/v0/webui/fs/media?path=%2Frepo%2Fartifacts%2Fencoded+chart.png&projectPath=%2Frepo'
  );
  assert.equal(
    utils.buildMarkdownImageSource('../images/chart.png', {
      baseDirectory: '/provider/brain/session',
      projectPath: '/repo'
    }),
    '/v0/webui/fs/media?path=%2Fprovider%2Fbrain%2Fsession%2F..%2Fimages%2Fchart.png&projectPath=%2Frepo'
  );
});

test('markdown image source preserves browser-backed and authenticated web urls', () => {
  const utils = loadFilePreviewUtils();

  assert.equal(utils.buildMarkdownImageSource('https://example.com/image.png'), 'https://example.com/image.png');
  assert.equal(utils.buildMarkdownImageSource('data:image/png;base64,abc'), 'data:image/png;base64,abc');
  assert.equal(utils.buildMarkdownImageSource('blob:http://localhost/id'), 'blob:http://localhost/id');
  assert.equal(
    utils.buildMarkdownImageSource('/v0/webui/chat/attachments?path=image.png'),
    '/v0/webui/chat/attachments?path=image.png'
  );
});

test('file preview resolves relative markdown images from the canonical markdown parent', () => {
  const utils = loadFilePreviewUtils();

  const canonicalMarkdownPath = '/Users/model/.gemini/antigravity-cli/brain/session/report.md';
  assert.equal(
    utils.getFileParentPath(canonicalMarkdownPath),
    '/Users/model/.gemini/antigravity-cli/brain/session'
  );
  assert.equal(
    utils.buildMarkdownImageSource('concert.jpg', {
      baseDirectory: utils.getFileParentPath(canonicalMarkdownPath),
      projectPath: '/repo'
    }),
    '/v0/webui/fs/media?path=%2FUsers%2Fmodel%2F.gemini%2Fantigravity-cli%2Fbrain%2Fsession%2Fconcert.jpg&projectPath=%2Frepo'
  );
});

test('markdown carousel fences split provider slides without treating them as code', () => {
  const utils = loadFilePreviewUtils();
  const content = [
    '![one](/provider/one.jpg)',
    '<!-- slide -->',
    '![two](/provider/two.jpg)',
    '<!--   slide   -->',
    '![three](/provider/three.jpg)'
  ].join('\n');

  assert.deepEqual(utils.parseMarkdownCarouselSlides('carousel', content), [
    '![one](/provider/one.jpg)',
    '![two](/provider/two.jpg)',
    '![three](/provider/three.jpg)'
  ]);
  assert.deepEqual(utils.parseMarkdownCarouselSlides('javascript', content), []);
});
