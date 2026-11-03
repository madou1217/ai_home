#!/usr/bin/env node
'use strict';

/**
 * 从 @opencode-ai/models SDK 离线快照生成 Go 模态索引。
 *
 * 用法:
 *   npm run models:generate   依据当前安装的 SDK 快照刷新 Go 模态索引
 *   npm run models:check      离线校验已提交索引与当前 SDK 快照一致
 *
 * models.dev 元数据的唯一权威来源是 SDK 自带的快照（package.json 钉精确版本），
 * 仓库不再 vendored catalog.json，也不存在任何抓取上游的命令。
 * 升级数据只需升级依赖：npm install @opencode-ai/models@latest && npm run models:generate。
 */

const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const nodeFs = require('node:fs');
const nodeOs = require('node:os');
const nodePath = require('node:path');

const REPO_ROOT = nodePath.resolve(__dirname, '..');
const MODELS_DEV_CATALOG_URL = 'https://models.dev/catalog.json';
const SNAPSHOT_SCHEMA_VERSION = 1;
const MODEL_MODALITIES_RELATIVE_PATH = 'internal/adapters/modelmetadata/modelsdev/modalities.json';
const MODEL_MODALITIES_PATH = nodePath.resolve(REPO_ROOT, MODEL_MODALITIES_RELATIVE_PATH);

function loadSdkCatalog() {
  // 直接读 SDK 的离线快照子路径，不经过其客户端 API，保证完全离线。
  const snapshot = require('@opencode-ai/models/snapshot');
  const catalog = { models: snapshot.models, providers: snapshot.providers };
  if (
    !catalog.models || typeof catalog.models !== 'object'
    || !catalog.providers || typeof catalog.providers !== 'object'
    || Object.keys(catalog.models).length < 1
    || Object.keys(catalog.providers).length < 1
  ) {
    throw new Error('@opencode-ai/models SDK 快照缺少 models/providers 数据');
  }
  return catalog;
}

// Go 生成器（internal/tools/modelsdevmodalities）的输入契约仍是带来源声明的
// 包装格式；该文档只作为临时输入存在，绝不提交进仓库。
function buildWrappedSnapshot(catalog) {
  const sha256 = createHash('sha256').update(JSON.stringify(catalog)).digest('hex');
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    source: {
      url: MODELS_DEV_CATALOG_URL,
      sha256
    },
    catalog
  };
}

function runModalitiesGenerator(sourcePath, targetPath) {
  execFileSync(
    'go',
    [
      'run',
      './internal/tools/modelsdevmodalities',
      '--source',
      sourcePath,
      '--target',
      targetPath
    ],
    { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  );
}

function removeTemporaryFile(filePath) {
  try {
    nodeFs.unlinkSync(filePath);
  } catch (error) {
    if (error && error.code !== 'ENOENT') throw error;
  }
}

function filesEqual(leftPath, rightPath) {
  if (!nodeFs.existsSync(leftPath) || !nodeFs.existsSync(rightPath)) return false;
  return nodeFs.readFileSync(leftPath).equals(nodeFs.readFileSync(rightPath));
}

function withTempCatalog(catalog, fn) {
  const temporaryDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'aih-models-dev-'));
  const temporaryCatalogPath = nodePath.join(temporaryDir, 'catalog.json');
  try {
    nodeFs.writeFileSync(temporaryCatalogPath, `${JSON.stringify(buildWrappedSnapshot(catalog))}\n`, 'utf8');
    return fn(temporaryCatalogPath);
  } finally {
    nodeFs.rmSync(temporaryDir, { recursive: true, force: true });
  }
}

function generate(catalog) {
  return withTempCatalog(catalog, (temporaryCatalogPath) => {
    const temporaryModalitiesPath = `${MODEL_MODALITIES_PATH}.tmp-${process.pid}`;
    try {
      runModalitiesGenerator(temporaryCatalogPath, temporaryModalitiesPath);
      if (filesEqual(temporaryModalitiesPath, MODEL_MODALITIES_PATH)) return false;
      nodeFs.renameSync(temporaryModalitiesPath, MODEL_MODALITIES_PATH);
      return true;
    } finally {
      removeTemporaryFile(temporaryModalitiesPath);
    }
  });
}

function check(catalog) {
  return withTempCatalog(catalog, (temporaryCatalogPath) => {
    const temporaryModalitiesPath = `${MODEL_MODALITIES_PATH}.check-${process.pid}`;
    try {
      runModalitiesGenerator(temporaryCatalogPath, temporaryModalitiesPath);
      if (!filesEqual(temporaryModalitiesPath, MODEL_MODALITIES_PATH)) {
        throw new Error(
          `Go 模态索引未与 @opencode-ai/models SDK 快照对齐: ${MODEL_MODALITIES_RELATIVE_PATH}；`
          + '请运行 npm run models:generate 并提交结果'
        );
      }
    } finally {
      removeTemporaryFile(temporaryModalitiesPath);
    }
  });
}

function sdkVersion() {
  try {
    // exports 映射未暴露 package.json，借快照入口路径向上定位
    const snapshotPath = require.resolve('@opencode-ai/models/snapshot');
    const manifestPath = nodePath.join(nodePath.dirname(snapshotPath), '..', 'package.json');
    return String(JSON.parse(nodeFs.readFileSync(manifestPath, 'utf8')).version || 'unknown');
  } catch (_error) {
    return 'unknown';
  }
}

function main() {
  const checkOnly = process.argv.slice(2).includes('--check');
  const catalog = loadSdkCatalog();
  const stats = `${Object.keys(catalog.models).length} models, ${Object.keys(catalog.providers).length} providers`;
  if (checkOnly) {
    check(catalog);
    console.log(`models.dev SDK 快照与 Go 模态索引一致 (SDK ${sdkVersion()}, ${stats})`);
    return;
  }
  const changed = generate(catalog);
  if (!changed) {
    console.log(`Go 模态索引已与 SDK 快照一致，无需更新 (SDK ${sdkVersion()}, ${stats})`);
    return;
  }
  console.log(`Go 模态索引已依据 SDK 快照更新 (SDK ${sdkVersion()}, ${stats})`);
  console.log(`  生成物: ${MODEL_MODALITIES_RELATIVE_PATH}`);
  console.log('生成物已产生变更；提交由调用方负责。');
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error && error.message || error);
    process.exitCode = 1;
  }
}

module.exports = {
  MODEL_MODALITIES_RELATIVE_PATH,
  MODELS_DEV_CATALOG_URL,
  SNAPSHOT_SCHEMA_VERSION,
  buildWrappedSnapshot,
  loadSdkCatalog
};
