'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  MODELS_DEV_CATALOG_URL,
  createSnapshot
} = require('../scripts/sync-models-dev');

const REPO_ROOT = path.resolve(__dirname, '..');
const WORKFLOW_PATH = path.join(
  REPO_ROOT,
  '.github',
  'workflows',
  'models-dev-sync.yml'
);

function readWorkflow() {
  return fs.readFileSync(WORKFLOW_PATH, 'utf8');
}

function createCatalogFixture() {
  return {
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
}

test('models.dev 同步在后台定时执行且不接入运行时请求链', () => {
  const workflow = readWorkflow();

  assert.match(workflow, /cron: '37 \*\/2 \* \* \*'/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /if: github\.ref == 'refs\/heads\/main'/);
  assert.doesNotMatch(workflow, /server start|aih-server|\/v1\/models/);
});

test('models.dev 同步只在内容变化且验证成功后提交固定产物', () => {
  const workflow = readWorkflow();

  assert.match(workflow, /npm run models:sync/);
  assert.match(workflow, /npm run models:check/);
  assert.match(workflow, /data\/models-dev\/catalog\.json/);
  assert.match(
    workflow,
    /go test \.\/internal\/adapters\/modelmetadata\/modelsdev \.\/internal\/tools\/modelsdevmodalities/
  );
  assert.match(workflow, /if: steps\.changes\.outputs\.changed == 'true'/);
  assert.match(workflow, /git diff --cached --check/);
  assert.match(workflow, /git push origin HEAD:main/);
  assert.doesNotMatch(workflow, /submodules:|third_party\/models\.dev/);
});

test('models.dev 固定快照记录官方 catalog URL 和内容哈希', () => {
  const catalog = createCatalogFixture();
  const snapshot = createSnapshot(catalog);

  assert.equal(snapshot.document.schemaVersion, 1);
  assert.equal(snapshot.document.source.url, MODELS_DEV_CATALOG_URL);
  assert.match(snapshot.document.source.sha256, /^[a-f0-9]{64}$/);
  assert.equal(snapshot.document.catalog, catalog);
  assert.equal(snapshot.stats.models, 1);
  assert.equal(snapshot.stats.providers, 1);
  assert.equal(snapshot.stats.providerModels, 1);
});

test('models.dev 普通 CI 检查只校验固定快照而不访问上游', () => {
  const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-models-check-'));
  const preloadPath = path.join(temporaryDir, 'reject-network.js');
  fs.writeFileSync(
    preloadPath,
    'globalThis.fetch = async () => { throw new Error("check mode attempted network fetch"); };\n'
  );

  try {
    const output = childProcess.execFileSync(
      process.execPath,
      ['scripts/sync-models-dev.js', '--check'],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require=${preloadPath}`.trim()
        }
      }
    );
    assert.match(output, /固定 API 快照与 Go 模态索引一致/);
  } finally {
    fs.rmSync(temporaryDir, { recursive: true, force: true });
  }
});

test('models.dev 自动提交保持最小权限和精确文件范围', () => {
  const workflow = readWorkflow();
  const catalogPath = 'data/models-dev/catalog.json';
  const modalitiesPath = 'internal/adapters/modelmetadata/modelsdev/modalities.json';

  assert.match(workflow, /permissions:\n  contents: write/);
  assert.doesNotMatch(workflow, /pull-requests: write/);
  assert.doesNotMatch(workflow, /create-pull-request|git push --force/);
  assert.equal((workflow.match(/git add --/g) || []).length, 1);
  assert.match(workflow, /git add -- \\\n            data\/models-dev\/catalog\.json/);
  assert.ok(workflow.includes(catalogPath));
  assert.ok(workflow.includes(modalitiesPath));
});

test('仓库不再声明 models.dev Git 子模块', () => {
  assert.equal(fs.existsSync(path.join(REPO_ROOT, '.gitmodules')), false);
});
