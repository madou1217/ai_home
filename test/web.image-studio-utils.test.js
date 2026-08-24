'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function loadUtils() {
  const ts = require(path.join(__dirname, '..', 'web', 'node_modules', 'typescript'));
  const filePath = path.join(
    __dirname,
    '..',
    'web',
    'src',
    'features',
    'image-studio',
    'image-studio-utils.ts'
  );
  const source = fs.readFileSync(filePath, 'utf8');
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

function sessionFixture() {
  return {
    id: 'img_session',
    title: '产品 / 主视觉',
    activeRevisionId: 'rev_2',
    revisions: [
      {
        id: 'rev_1',
        status: 'succeeded',
        sourceAssetIds: [],
        outputAssetIds: ['asset_1'],
        prompt: 'first'
      },
      {
        id: 'rev_2',
        status: 'failed',
        sourceAssetIds: ['asset_1'],
        outputAssetIds: [],
        prompt: 'second'
      }
    ],
    assets: [
      { id: 'asset_1', mimeType: 'image/png', byteLength: 100 },
      { id: 'asset_other', mimeType: 'image/jpeg', byteLength: 200 }
    ]
  };
}

test('image Studio selection follows the active failed revision and its scoped source asset', () => {
  const utils = loadUtils();
  const session = sessionFixture();
  assert.equal(utils.getLatestRevisionId(session), 'rev_2');
  const revision = utils.resolveSelectedRevision(session, 'missing');
  assert.equal(revision.id, 'rev_2');
  assert.equal(utils.resolveSelectedAsset(session, revision, 'asset_other').id, 'asset_1');
});

test('image Studio download names preserve readable titles without unsafe separators', () => {
  const utils = loadUtils();
  const session = sessionFixture();
  assert.equal(
    utils.makeRevisionDownloadName(session, session.revisions[0], session.assets[0]),
    '产品-主视觉-r01.png'
  );
  assert.equal(utils.imageFileExtension('image/jpeg'), 'jpg');
});

test('image Studio upload validation enforces supported mime and four MiB limit', () => {
  const utils = loadUtils();
  assert.equal(utils.validateImageStudioUpload({ type: 'image/png', size: 1024 }), '');
  assert.equal(utils.validateImageStudioUpload({ type: 'image/png', size: 1024 }, 'mask'), '');
  assert.match(utils.validateImageStudioUpload({ type: 'image/jpeg', size: 1024 }, 'mask'), /PNG/);
  assert.match(utils.validateImageStudioUpload({ type: 'image/svg+xml', size: 1024 }), /PNG/);
  assert.match(utils.validateImageStudioUpload({ type: 'image/png', size: 5 * 1024 * 1024 }), /4 MiB/);
});

test('image Studio upload budget prevents base64 expansion from exceeding the 16 MiB request limit', () => {
  const utils = loadUtils();
  assert.equal(typeof utils.validateImageStudioUploadBudget, 'function');
  const max = utils.IMAGE_STUDIO_MAX_UPLOAD_BYTES;
  assert.equal(utils.validateImageStudioUploadBudget([max, max]), '');
  assert.match(utils.validateImageStudioUploadBudget([max, max, max]), /16 MiB/);
});

test('image Studio asset keys keep sessions isolated in the browser cache', () => {
  const utils = loadUtils();
  assert.notEqual(
    utils.imageStudioAssetKey('img_a', 'asset_1'),
    utils.imageStudioAssetKey('img_b', 'asset_1')
  );
});

test('image Studio asset cache prunes inactive urls and caps automatic retries', () => {
  const utils = loadUtils();
  const cache = new Map([
    ['img_a:asset_1', 'blob:active'],
    ['img_b:asset_2', 'blob:stale']
  ]);
  const revoked = [];

  assert.equal(
    utils.pruneImageStudioAssetUrls(cache, new Set(['img_a:asset_1']), (url) => revoked.push(url)),
    1
  );
  assert.deepEqual([...cache.entries()], [['img_a:asset_1', 'blob:active']]);
  assert.deepEqual(revoked, ['blob:stale']);
  assert.equal(utils.shouldAutoRetryImageStudioAsset(1), true);
  assert.equal(utils.shouldAutoRetryImageStudioAsset(2), true);
  assert.equal(utils.shouldAutoRetryImageStudioAsset(3), false);
});

test('image Studio model selection follows live account availability', () => {
  const utils = loadUtils();
  const models = [
    { key: 'codex:gpt-image-2', availableAccountCount: 0 },
    { key: 'agy:gemini-image', availableAccountCount: 1 },
    { key: 'grok:grok-image', availableAccountCount: 1 }
  ];

  assert.equal(
    utils.selectInitialImageStudioModel(models, 'codex:gpt-image-2', 'grok:grok-image'),
    'grok:grok-image'
  );
  assert.equal(
    utils.selectInitialImageStudioModel(models, 'agy:gemini-image', 'grok:grok-image'),
    'agy:gemini-image'
  );
});

test('image Studio quality choices follow the selected model catalog instead of advertising rejected values', () => {
  const utils = loadUtils();
  assert.deepEqual(
    utils.getImageStudioQualityOptions({
      capabilities: { quality: true },
      qualityOptions: ['low', 'medium', 'medium']
    }),
    ['auto', 'low', 'medium']
  );
  assert.deepEqual(
    utils.getImageStudioQualityOptions({
      capabilities: { quality: false },
      qualityOptions: ['high']
    }),
    ['auto']
  );
});

test('image Studio reference limits reject the whole overflowing selection', () => {
  const utils = loadUtils();
  const model = { capabilities: { maxInputImages: 3 } };
  assert.equal(utils.getImageStudioSourceLimit(model), 3);
  assert.equal(utils.validateImageStudioSourceCount(1, 2, model), '');
  assert.match(utils.validateImageStudioSourceCount(2, 2, model), /最多 3 张/);
});

test('image Studio rebuilds a failed revision draft with a compatible live model and persisted assets', () => {
  const utils = loadUtils();
  const draft = utils.buildImageStudioRevisionDraft([
    {
      key: 'codex:gpt-image-2',
      availableAccountCount: 0,
      capabilities: {
        edit: true,
        mask: true,
        multiple: false,
        size: false,
        quality: false,
        maxInputImages: 16,
        background: true,
        outputFormat: true,
        outputCompression: true,
        moderation: true
      }
    },
    {
      key: 'grok:grok-imagine-image-2.0',
      availableAccountCount: 1,
      capabilities: {
        edit: true,
        mask: false,
        multiple: true,
        size: false,
        quality: true,
        maxInputImages: 3,
        background: false,
        outputFormat: false,
        outputCompression: false,
        moderation: false
      },
      qualityOptions: ['low', 'medium']
    }
  ], {
    id: 'rev_failed',
    parentRevisionId: 'rev_parent',
    mode: 'edit',
    prompt: 'keep shape, change lighting',
    modelKey: 'codex:gpt-image-2',
    sourceAssetIds: ['asset_source', 'asset_reference'],
    maskAssetId: 'asset_mask',
    parameters: {
      n: 3,
      size: '1536x1024',
      quality: 'high',
      background: 'transparent',
      outputFormat: 'webp',
      outputCompression: 75,
      moderation: 'low'
    }
  });

  assert.deepEqual(draft, {
    modelKey: 'grok:grok-imagine-image-2.0',
    mode: 'edit',
    prompt: 'keep shape, change lighting',
    outputCount: 3,
    size: 'auto',
    quality: 'auto',
    sourceAssetIds: ['asset_source', 'asset_reference'],
    maskAssetId: '',
    background: 'auto',
    outputFormat: 'png',
    outputCompression: 100,
    moderation: 'auto',
    parentRevisionId: 'rev_parent'
  });
});

test('image Studio revision drafts do not turn unset compression into zero quality', () => {
  const utils = loadUtils();
  const draft = utils.buildImageStudioRevisionDraft([{
    key: 'codex:gpt-image-2',
    availableAccountCount: 1,
    capabilities: {
      generation: true,
      edit: true,
      mask: true,
      multiple: true,
      size: true,
      quality: true,
      maxInputImages: 16,
      background: true,
      outputFormat: true,
      outputCompression: true,
      moderation: true
    }
  }], {
    id: 'rev_failed',
    parentRevisionId: '',
    mode: 'generation',
    prompt: 'product frame',
    modelKey: 'codex:gpt-image-2',
    sourceAssetIds: [],
    maskAssetId: '',
    parameters: {
      n: 1,
      size: '',
      quality: '',
      background: 'auto',
      outputFormat: 'png',
      outputCompression: null,
      moderation: 'auto'
    }
  });

  assert.equal(draft.outputCompression, 100);
});

test('image Studio explains why gpt-image-2 is present but unavailable', () => {
  const utils = loadUtils();
  const detail = utils.formatImageStudioModelAvailability?.({
    key: 'codex:gpt-image-2',
    accountCount: 3,
    availableAccountCount: 0,
    unavailableReasons: [
      { reason: 'blocked_by_quota:usage_exhausted', count: 2 },
      { reason: 'blocked_by_policy:codex_usage_below_server_threshold', count: 1 }
    ]
  });

  assert.equal(detail, '2 个账号额度已用尽；1 个账号低于服务器额度保护阈值');
});

test('image Studio request builder omits unsupported controls and stale generation inputs', () => {
  const utils = loadUtils();
  const input = utils.buildImageStudioRunInput({
    model: {
      key: 'codex:gpt-image-2',
      capabilities: {
        generation: true,
        edit: true,
        mask: false,
        multiple: false,
        size: false,
        quality: false,
        responseFormat: true,
        maxInputImages: 1,
        background: false,
        outputFormat: false,
        outputCompression: false,
        moderation: false
      }
    },
    mode: 'generation',
    prompt: '  product frame  ',
    parentRevisionId: 'rev_stale',
    sources: [{ assetId: 'asset_stale' }],
    maskAssetId: 'mask_stale',
    n: 4,
    size: 'auto',
    quality: 'auto',
    background: 'transparent',
    outputFormat: 'webp',
    outputCompression: 75,
    moderation: 'low'
  });
  assert.deepEqual(input, {
    mode: 'generation',
    modelKey: 'codex:gpt-image-2',
    prompt: 'product frame',
    n: 1
  });
});

test('image Studio request builder preserves controls supported by an edit model', () => {
  const utils = loadUtils();
  const input = utils.buildImageStudioRunInput({
    model: {
      key: 'codex:gpt-image-api',
      capabilities: {
        generation: true,
        edit: true,
        mask: true,
        multiple: true,
        size: true,
        quality: true,
        responseFormat: true,
        maxInputImages: 16,
        background: true,
        outputFormat: true,
        outputCompression: true,
        moderation: true
      }
    },
    mode: 'edit',
    prompt: 'replace sky',
    parentRevisionId: 'rev_1',
    sources: [
      { assetId: 'asset_source' },
      { image: 'data:image/png;base64,reference' }
    ],
    maskImage: 'data:image/png;base64,mask',
    n: 3,
    size: '1024x1024',
    quality: 'high',
    background: 'transparent',
    outputFormat: 'webp',
    outputCompression: 64,
    moderation: 'low'
  });
  assert.deepEqual(input, {
    mode: 'edit',
    modelKey: 'codex:gpt-image-api',
    prompt: 'replace sky',
    parentRevisionId: 'rev_1',
    sources: [
      { assetId: 'asset_source' },
      { image: 'data:image/png;base64,reference' }
    ],
    mask: 'data:image/png;base64,mask',
    n: 3,
    size: '1024x1024',
    quality: 'high',
    background: 'transparent',
    output_format: 'webp',
    output_compression: 64,
    moderation: 'low'
  });
});

test('image Studio request builder treats auto controls as provider defaults', () => {
  const utils = loadUtils();
  const input = utils.buildImageStudioRunInput({
    model: {
      key: 'grok:grok-imagine-image-2.0',
      capabilities: {
        generation: true,
        edit: true,
        mask: false,
        multiple: true,
        size: false,
        quality: true,
        responseFormat: true,
        maxInputImages: 3,
        background: false,
        outputFormat: false,
        outputCompression: false,
        moderation: false
      }
    },
    mode: 'generation',
    prompt: 'portrait',
    n: 1,
    size: 'auto',
    quality: 'auto',
    background: 'auto',
    outputFormat: 'png',
    outputCompression: 100,
    moderation: 'auto'
  });
  assert.deepEqual(input, {
    mode: 'generation',
    modelKey: 'grok:grok-imagine-image-2.0',
    prompt: 'portrait',
    n: 1
  });
});

test('image Studio frontend follows session history, refreshes model health and leaves run timeout to the server', () => {
  const root = path.join(__dirname, '..', 'web', 'src');
  const workspace = fs.readFileSync(
    path.join(root, 'features', 'image-studio', 'ImageStudioWorkspace.tsx'),
    'utf8'
  );
  const assetHook = fs.readFileSync(
    path.join(root, 'features', 'image-studio', 'use-image-studio-assets.ts'),
    'utf8'
  );
  const apiSource = fs.readFileSync(path.join(root, 'services', 'api.ts'), 'utf8');
  const runStart = apiSource.indexOf('run: async (sessionId: string, input: ImageStudioRunInput)');
  const runEnd = apiSource.indexOf('getAssetBlob:', runStart);
  const runSource = apiSource.slice(runStart, runEnd);

  assert.match(workspace, /const requestedSessionId = searchParams\.get\('session'\) \|\| '';/);
  assert.ok((workspace.match(/imageStudioAPI\.listModels\(\)/g) || []).length >= 3);
  assert.match(assetHook, /!activeKeysRef\.current\.has\(key\)/);
  assert.match(assetHook, /window\.addEventListener\('focus', retryFailedAssets\)/);
  assert.match(workspace, /activeSessionIdRef\.current === runSessionId/);
  assert.match(workspace, /imageStudioAPI\.deleteSession/);
  assert.match(apiSource, /deleteSession:\s*async/);
  assert.match(runSource, /\{ timeout: 0 \}/);
  assert.doesNotMatch(runSource, /180000/);
});
