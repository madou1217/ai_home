'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  MODELS_DEV_CATALOG_URL,
  SNAPSHOT_SCHEMA_VERSION,
  buildWrappedSnapshot,
  loadSdkCatalog
} = require('../scripts/gen-models-dev-modalities');

const REPO_ROOT = path.resolve(__dirname, '..');

test('models.dev 元数据来源是 @opencode-ai/models SDK 依赖', () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')
  );
  assert.ok(
    manifest.dependencies && manifest.dependencies['@opencode-ai/models'],
    'package.json 必须声明 @opencode-ai/models 依赖'
  );

  const catalog = loadSdkCatalog();
  assert.ok(Object.keys(catalog.models).length > 0);
  assert.ok(Object.keys(catalog.providers).length > 0);
});

test('models.dev 仓库内不再 vendored catalog 快照或同步 workflow', () => {
  assert.equal(fs.existsSync(path.join(REPO_ROOT, 'data/models-dev/catalog.json')), false);
  assert.equal(
    fs.existsSync(path.join(REPO_ROOT, '.github/workflows/models-dev-sync.yml')),
    false
  );
  assert.equal(fs.existsSync(path.join(REPO_ROOT, '.gitmodules')), false);

  const ci = fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');
  assert.doesNotMatch(ci, /models:sync/);
  // models:check 依赖 node_modules 里的 SDK 快照，必须先安装依赖
  assert.ok(
    ci.indexOf('npm install') > -1
      && ci.indexOf('npm install') < ci.indexOf('npm run models:check'),
    'ci.yml 必须先安装依赖再校验 models.dev 生成物'
  );
});

test('models.dev 包装快照满足 Go 生成器的来源契约', () => {
  const catalog = {
    models: {
      'openai/gpt-test': {
        id: 'openai/gpt-test',
        modalities: { input: ['text'], output: ['text'] }
      }
    },
    providers: {
      openai: {
        id: 'openai',
        models: {
          'gpt-test': {
            id: 'gpt-test',
            modalities: { input: ['text'], output: ['text'] }
          }
        }
      }
    }
  };
  const wrapped = buildWrappedSnapshot(catalog);

  assert.equal(wrapped.schemaVersion, SNAPSHOT_SCHEMA_VERSION);
  assert.equal(wrapped.source.url, MODELS_DEV_CATALOG_URL);
  assert.match(wrapped.source.sha256, /^[a-f0-9]{64}$/);
  assert.equal(wrapped.catalog, catalog);
});

test('models.dev 生成物检查完全离线且与 SDK 快照一致', () => {
  const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-models-check-'));
  const preloadPath = path.join(temporaryDir, 'reject-network.js');
  fs.writeFileSync(
    preloadPath,
    'globalThis.fetch = async () => { throw new Error("check mode attempted network fetch"); };\n'
  );

  try {
    const output = childProcess.execFileSync(
      process.execPath,
      ['scripts/gen-models-dev-modalities.js', '--check'],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require=${preloadPath}`.trim()
        }
      }
    );
    assert.match(output, /SDK 快照与 Go 模态索引一致/);
  } finally {
    fs.rmSync(temporaryDir, { recursive: true, force: true });
  }
});
