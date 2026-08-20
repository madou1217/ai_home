#!/usr/bin/env node
'use strict';

/**
 * 从 models.dev 官方 catalog API 更新仓库内固定快照，并生成 Go 模态索引。
 *
 * 用法:
 *   npm run models:sync            下载、校验并原子替换固定快照
 *   npm run models:check           仅离线校验仓库快照及 Go 生成物
 *
 * Server 启动和推理请求只读取固定快照；只有显式同步命令和异步 CI 访问上游。
 */

const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const nodeFs = require('node:fs');
const nodePath = require('node:path');

const REPO_ROOT = nodePath.resolve(__dirname, '..');
const MODELS_DEV_CATALOG_URL = 'https://models.dev/catalog.json';
const SNAPSHOT_SCHEMA_VERSION = 1;
const MAX_CATALOG_BYTES = 20 * 1024 * 1024;
const MODEL_CATALOG_RELATIVE_PATH = 'data/models-dev/catalog.json';
const MODEL_CATALOG_PATH = nodePath.resolve(REPO_ROOT, MODEL_CATALOG_RELATIVE_PATH);
const MODEL_MODALITIES_RELATIVE_PATH = 'internal/adapters/modelmetadata/modelsdev/modalities.json';
const MODEL_MODALITIES_PATH = nodePath.resolve(REPO_ROOT, MODEL_MODALITIES_RELATIVE_PATH);

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hashCatalog(catalog) {
  return createHash('sha256').update(JSON.stringify(catalog)).digest('hex');
}

function validateModalities(record, label) {
  const modalities = record && record.modalities;
  const input = modalities && modalities.input;
  const output = modalities && modalities.output;
  if (
    !Array.isArray(input)
    || input.length < 1
    || input.some((item) => typeof item !== 'string' || !item.trim())
    || !Array.isArray(output)
    || output.length < 1
    || output.some((item) => typeof item !== 'string' || !item.trim())
  ) {
    throw new Error(`models.dev catalog 模态无效: ${label}`);
  }
}

function validateCatalog(catalog) {
  if (!isRecord(catalog) || !isRecord(catalog.models) || !isRecord(catalog.providers)) {
    throw new Error('models.dev catalog 缺少 models/providers 对象');
  }

  const modelEntries = Object.entries(catalog.models);
  const providerEntries = Object.entries(catalog.providers);
  if (modelEntries.length < 1 || providerEntries.length < 1) {
    throw new Error('models.dev catalog 不能为空');
  }

  modelEntries.forEach(([modelId, model]) => {
    if (!modelId.trim() || !isRecord(model) || String(model.id || '') !== modelId) {
      throw new Error(`models.dev canonical model 无效: ${modelId || '<empty>'}`);
    }
    validateModalities(model, `models/${modelId}`);
  });

  let providerModelCount = 0;
  providerEntries.forEach(([providerId, provider]) => {
    if (!providerId.trim() || !isRecord(provider) || String(provider.id || '') !== providerId) {
      throw new Error(`models.dev provider 无效: ${providerId || '<empty>'}`);
    }
    if (!isRecord(provider.models)) {
      throw new Error(`models.dev provider 缺少 models: ${providerId}`);
    }
    Object.entries(provider.models).forEach(([modelId, model]) => {
      if (!modelId.trim() || !isRecord(model) || !String(model.id || '').trim()) {
        throw new Error(`models.dev provider model 无效: ${providerId}/${modelId}`);
      }
      providerModelCount += 1;
    });
  });
  if (providerModelCount < 1) throw new Error('models.dev provider model 不能为空');

  return {
    models: modelEntries.length,
    providers: providerEntries.length,
    providerModels: providerModelCount
  };
}

function createSnapshot(catalog) {
  const stats = validateCatalog(catalog);
  const sha256 = hashCatalog(catalog);
  const document = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    source: {
      url: MODELS_DEV_CATALOG_URL,
      sha256
    },
    catalog
  };
  return {
    document,
    stats,
    text: `${JSON.stringify(document)}\n`
  };
}

function validateSnapshotDocument(document) {
  if (!isRecord(document) || document.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    throw new Error(`models.dev 固定快照 schemaVersion 必须为 ${SNAPSHOT_SCHEMA_VERSION}`);
  }
  if (!isRecord(document.source) || document.source.url !== MODELS_DEV_CATALOG_URL) {
    throw new Error(`models.dev 固定快照来源必须为 ${MODELS_DEV_CATALOG_URL}`);
  }
  if (!/^[a-f0-9]{64}$/.test(String(document.source.sha256 || ''))) {
    throw new Error('models.dev 固定快照缺少有效 sha256');
  }
  const snapshot = createSnapshot(document.catalog);
  if (snapshot.document.source.sha256 !== document.source.sha256) {
    throw new Error('models.dev 固定快照 sha256 不匹配');
  }
  return snapshot;
}

function readSnapshot() {
  if (!nodeFs.existsSync(MODEL_CATALOG_PATH)) {
    throw new Error(`models.dev 固定快照不存在: ${MODEL_CATALOG_RELATIVE_PATH}`);
  }
  const text = nodeFs.readFileSync(MODEL_CATALOG_PATH, 'utf8');
  let document;
  try {
    document = JSON.parse(text);
  } catch (error) {
    throw new Error(`models.dev 固定快照 JSON 无效: ${error.message}`);
  }
  const snapshot = validateSnapshotDocument(document);
  if (text !== snapshot.text) {
    throw new Error(`models.dev 固定快照不是规范格式: ${MODEL_CATALOG_RELATIVE_PATH}`);
  }
  return snapshot;
}

function gitStatus(relativePath) {
  return execFileSync('git', ['status', '--short', '--', relativePath], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}

function assertSyncOutputsClean() {
  [MODEL_CATALOG_RELATIVE_PATH, MODEL_MODALITIES_RELATIVE_PATH].forEach((relativePath) => {
    const status = gitStatus(relativePath);
    if (status) throw new Error(`models.dev 生成物存在未提交修改，拒绝覆盖: ${status}`);
  });
}

async function fetchCatalog(fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') throw new Error('当前 Node.js 不支持 fetch');
  const response = await fetchImpl(MODELS_DEV_CATALOG_URL, {
    headers: {
      accept: 'application/json',
      'user-agent': 'ai-home-models-sync'
    },
    signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok) {
    throw new Error(`models.dev catalog 请求失败: HTTP ${response.status}`);
  }
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length < 1 || body.length > MAX_CATALOG_BYTES) {
    throw new Error(`models.dev catalog 大小异常: ${body.length} bytes`);
  }
  try {
    return JSON.parse(body.toString('utf8'));
  } catch (error) {
    throw new Error(`models.dev catalog JSON 无效: ${error.message}`);
  }
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

function replaceIfChanged(temporaryPath, targetPath) {
  if (filesEqual(temporaryPath, targetPath)) {
    removeTemporaryFile(temporaryPath);
    return false;
  }
  nodeFs.renameSync(temporaryPath, targetPath);
  return true;
}

function generateOutputs(snapshot) {
  nodeFs.mkdirSync(nodePath.dirname(MODEL_CATALOG_PATH), { recursive: true });
  const catalogTemporaryPath = `${MODEL_CATALOG_PATH}.tmp-${process.pid}`;
  const modalitiesTemporaryPath = `${MODEL_MODALITIES_PATH}.tmp-${process.pid}`;
  try {
    nodeFs.writeFileSync(catalogTemporaryPath, snapshot.text, 'utf8');
    runModalitiesGenerator(catalogTemporaryPath, modalitiesTemporaryPath);
    const catalogChanged = replaceIfChanged(catalogTemporaryPath, MODEL_CATALOG_PATH);
    const modalitiesChanged = replaceIfChanged(modalitiesTemporaryPath, MODEL_MODALITIES_PATH);
    return { catalogChanged, modalitiesChanged };
  } finally {
    removeTemporaryFile(catalogTemporaryPath);
    removeTemporaryFile(modalitiesTemporaryPath);
  }
}

function assertGeneratedSnapshotAligned(snapshot) {
  const temporaryPath = `${MODEL_MODALITIES_PATH}.check-${process.pid}`;
  try {
    runModalitiesGenerator(MODEL_CATALOG_PATH, temporaryPath);
    if (!filesEqual(temporaryPath, MODEL_MODALITIES_PATH)) {
      throw new Error(`Go 模态快照未与 models.dev catalog 对齐: ${MODEL_MODALITIES_RELATIVE_PATH}`);
    }
  } finally {
    removeTemporaryFile(temporaryPath);
  }
  return snapshot;
}

async function main() {
  const checkOnly = process.argv.slice(2).includes('--check');
  if (checkOnly) {
    const snapshot = assertGeneratedSnapshotAligned(readSnapshot());
    console.log(
      `models.dev 固定 API 快照与 Go 模态索引一致 `
      + `(${snapshot.document.source.sha256.slice(0, 12)}, `
      + `${snapshot.stats.models} models, ${snapshot.stats.providers} providers)`
    );
    return;
  }

  assertSyncOutputsClean();
  const before = nodeFs.existsSync(MODEL_CATALOG_PATH) ? readSnapshot() : null;
  const snapshot = createSnapshot(await fetchCatalog());
  const changed = generateOutputs(snapshot);
  const beforeHash = before && before.document.source.sha256;
  const afterHash = snapshot.document.source.sha256;

  if (!changed.catalogChanged && !changed.modalitiesChanged) {
    console.log(
      `models.dev API 快照已是最新 (${afterHash.slice(0, 12)}, `
      + `${snapshot.stats.models} models, ${snapshot.stats.providers} providers)`
    );
    return;
  }

  console.log(
    `models.dev API 快照已更新: ${beforeHash ? beforeHash.slice(0, 12) : '<none>'}`
    + ` → ${afterHash.slice(0, 12)}`
  );
  console.log(
    `  数据量: ${snapshot.stats.models} canonical models, `
    + `${snapshot.stats.providers} providers, ${snapshot.stats.providerModels} provider models`
  );
  console.log(`  固定快照: ${MODEL_CATALOG_RELATIVE_PATH}`);
  console.log(`  Go 模态索引: ${MODEL_MODALITIES_RELATIVE_PATH}`);
  console.log('生成物已产生变更；提交由调用方负责。');
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error && error.message || error);
    process.exitCode = 1;
  });
}

module.exports = {
  MODEL_CATALOG_RELATIVE_PATH,
  MODEL_MODALITIES_RELATIVE_PATH,
  MODELS_DEV_CATALOG_URL,
  SNAPSHOT_SCHEMA_VERSION,
  createSnapshot,
  fetchCatalog,
  validateCatalog,
  validateSnapshotDocument
};
