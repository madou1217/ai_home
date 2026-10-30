'use strict';

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const { fetchGatewayModelCatalog } = require('./gateway-catalog');
const { writePrivateJson } = require('./projection');

// 账号事件触发的「模型投影刷新」。
//
// 运行中的 harness 不会替我们重写自己的模型文件（Pi 有 TUI 扩展轮询兜底，
// 其他工具没有），所以 server 在账号生命周期变化后主动把网关当前目录写回
// 每个投影目录。语义必须与 Pi 的 TUI 扩展（lib/harness/pi-extension.ts）一致：
//   - 只按模型 id 集合判断是否变化；
//   - 已存在的条目原样保留（contextWindow / cost / thinkingLevelMap 都是
//     models.json 里更精确的事实，刷新不能把它们降级成默认值）；
//   - 新出现的 id 用最小字段补入。
// 不一致的代价：扩展每 5 分钟把 server 刚写的文件再改回去，形成写放大。

const INPUT_MODALITIES = new Set(['text', 'image']);

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

function modelIds(models) {
  return (Array.isArray(models) ? models : []).map((model) => normalizeText(model && model.id));
}

function sameIds(left, right) {
  const a = modelIds(left);
  const b = modelIds(right);
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

function buildInput(row) {
  const modalities = row && row.modalities && typeof row.modalities === 'object' ? row.modalities : null;
  const source = modalities && Array.isArray(modalities.input) ? modalities.input : [];
  const input = source
    .map((item) => normalizeText(item).toLowerCase())
    .filter((item) => INPUT_MODALITIES.has(item));
  if (!input.includes('text')) input.unshift('text');
  return input;
}

function mergeModelsPreservingMetadata(current, rows) {
  const previous = new Map();
  for (const model of Array.isArray(current) ? current : []) {
    const id = normalizeText(model && model.id);
    if (id) previous.set(id, model);
  }
  const byId = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = normalizeText(row && row.id);
    if (!id || byId.has(id)) continue;
    const existing = previous.get(id);
    byId.set(id, existing && typeof existing === 'object'
      ? existing
      : { id, name: id, input: buildInput(row) });
  }
  return Array.from(byId.values());
}

function listProjectionDirs(fsImpl, pathImpl, aiHomeDir, harnessId) {
  const root = pathImpl.join(aiHomeDir, 'run', 'harness', harnessId);
  let entries = [];
  try {
    entries = fsImpl.readdirSync(root, { withFileTypes: true });
  } catch (_error) {
    return { root, dirs: [] };
  }
  const dirs = entries
    .filter((entry) => entry && entry.isDirectory && entry.isDirectory())
    .map((entry) => pathImpl.join(root, entry.name));
  return { root, dirs };
}

function readJson(fsImpl, filePath) {
  try {
    return JSON.parse(fsImpl.readFileSync(filePath, 'utf8'));
  } catch (_error) {
    return null;
  }
}

// Pi 的模型事实源是 <agentDir>/models.json 的 providers.aih.models。
// 其他 harness 的模型配置形状不同，后续按适配器表扩展，不在这里写 provider 分支。
function applyPiModels(document, rows) {
  const profile = document && document.providers && document.providers.aih;
  if (!profile || typeof profile !== 'object') return false;
  const current = Array.isArray(profile.models) ? profile.models : [];
  const next = mergeModelsPreservingMetadata(current, rows);
  if (!next.length || sameIds(current, next)) return false;
  profile.models = next;
  return true;
}

const HARNESS_MODEL_PROJECTIONS = Object.freeze({
  pi: { modelsPath: 'models.json', applyModels: applyPiModels }
});

function listRefreshableHarnesses() {
  return Object.keys(HARNESS_MODEL_PROJECTIONS);
}

async function refreshHarnessModelProjections(input = {}) {
  const fsImpl = input.fs || nodeFs;
  const pathImpl = input.path || nodePath;
  const aiHomeDir = normalizeText(input.aiHomeDir);
  const harnessId = normalizeText(input.harnessId || 'pi').toLowerCase();
  const projection = HARNESS_MODEL_PROJECTIONS[harnessId];
  if (!aiHomeDir) return { ok: false, error: 'ai_home_dir_missing', harness: harnessId };
  if (!projection) return { ok: false, error: 'harness_projection_unknown', harness: harnessId };
  const connection = input.connection || {};
  const baseUrl = normalizeText(connection.baseUrl).replace(/\/+$/, '');
  const apiKey = normalizeText(connection.apiKey);
  if (!baseUrl || !apiKey) {
    return { ok: false, error: 'gateway_connection_missing', harness: harnessId };
  }

  const { root, dirs } = listProjectionDirs(fsImpl, pathImpl, aiHomeDir, harnessId);
  if (!dirs.length) return { ok: true, harness: harnessId, root, scanned: 0, updated: 0 };

  let catalog = null;
  try {
    catalog = await fetchGatewayModelCatalog({
      baseUrl,
      apiKey,
      fetchImpl: input.fetchImpl,
      timeoutMs: input.timeoutMs
    });
  } catch (error) {
    return {
      ok: false,
      harness: harnessId,
      error: 'gateway_catalog_unavailable',
      message: String(error && error.message || error)
    };
  }
  const rows = Array.isArray(catalog && catalog.models) ? catalog.models : [];
  if (!rows.length) return { ok: false, harness: harnessId, error: 'gateway_catalog_empty' };

  let updated = 0;
  const errors = [];
  for (const dir of dirs) {
    const filePath = pathImpl.join(dir, projection.modelsPath);
    const document = readJson(fsImpl, filePath);
    if (!document) continue;
    let changed = false;
    try {
      changed = projection.applyModels(document, rows);
    } catch (error) {
      errors.push({ dir, error: String(error && error.message || error) });
      continue;
    }
    if (!changed) continue;
    try {
      writePrivateJson(fsImpl, filePath, document);
      updated += 1;
    } catch (error) {
      errors.push({ dir, error: String(error && error.message || error) });
    }
  }
  return {
    ok: errors.length === 0,
    harness: harnessId,
    root,
    scanned: dirs.length,
    updated,
    ...(errors.length ? { errors } : {})
  };
}

module.exports = {
  HARNESS_MODEL_PROJECTIONS,
  listRefreshableHarnesses,
  mergeModelsPreservingMetadata,
  refreshHarnessModelProjections
};
