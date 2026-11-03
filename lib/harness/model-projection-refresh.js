'use strict';

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const { fetchGatewayModelCatalog } = require('./gateway-catalog');
const { writePrivateJson, writePrivateText } = require('./projection');
const { parseDshPatch, serializeDshPatch } = require('./dsh');

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
      : { id, name: normalizeText(row && row.name) || id, input: buildInput(row) });
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

// DSH / dsh-tui 的模型事实源是 profile 的 cordis.patch.yml：llm-pi-ai 条目的
// config.providers.aih.models。解析/序列化复用 dsh.js 自己的那套，保证与启动时
// 写出的文件形状一致 —— 形状不一致会让下一次启动把这里的改动覆盖回去。
function applyDshModels(entries, rows) {
  const llm = (Array.isArray(entries) ? entries : [])
    .find((entry) => entry && typeof entry === 'object' && entry.id === 'llm-pi-ai');
  const config = llm && llm.config && typeof llm.config === 'object' ? llm.config : null;
  const providers = config && config.providers && typeof config.providers === 'object' ? config.providers : null;
  const profile = providers && providers.aih;
  if (!profile || typeof profile !== 'object') return false;
  const current = Array.isArray(profile.models) ? profile.models : [];
  const next = mergeModelsPreservingMetadata(current, rows);
  if (!next.length || sameIds(current, next)) return false;
  profile.models = next;
  return true;
}

// 投影描述符只声明「模型事实源在哪、用什么格式读写、怎么改」。
// 新增一个 harness = 加一行；刷新逻辑与事件监听者都不需要知道它是谁。
const HARNESS_MODEL_PROJECTIONS = Object.freeze({
  pi: { modelsPath: 'models.json', format: 'json', applyModels: applyPiModels },
  dsh: {
    modelsPath: 'profiles/aih/cordis.patch.yml',
    format: 'dsh_patch_yaml',
    applyModels: applyDshModels
  },
  'dsh-tui': {
    modelsPath: 'dsh/profiles/dsh-tui/cordis.patch.yml',
    format: 'dsh_patch_yaml',
    applyModels: applyDshModels
  }
});

function readDocument(fsImpl, filePath, format) {
  try {
    const text = fsImpl.readFileSync(filePath, 'utf8');
    if (format === 'dsh_patch_yaml') return parseDshPatch(text);
    return JSON.parse(text);
  } catch (_error) {
    return null;
  }
}

function writeDocument(fsImpl, filePath, format, document) {
  if (format === 'dsh_patch_yaml') {
    writePrivateText(fsImpl, filePath, serializeDshPatch(document));
    return;
  }
  writePrivateJson(fsImpl, filePath, document);
}

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

  // 同一次事件里多个 harness 共用一份目录结果，由 refreshAllHarnessModelProjections 注入。
  let catalog = input.catalog && Array.isArray(input.catalog.models) ? input.catalog : null;
  try {
    catalog = catalog || await fetchGatewayModelCatalog({
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

  const format = projection.format || 'json';
  let updated = 0;
  const errors = [];
  for (const dir of dirs) {
    const filePath = pathImpl.join(dir, projection.modelsPath);
    const document = readDocument(fsImpl, filePath, format);
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
      writeDocument(fsImpl, filePath, format, document);
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

// 一次事件 = 一次目录读取：所有 harness 共用同一份 /v1/models 结果。
// 没有任何投影目录时连网关都不打扰。
async function refreshAllHarnessModelProjections(input = {}) {
  const fsImpl = input.fs || nodeFs;
  const pathImpl = input.path || nodePath;
  const aiHomeDir = normalizeText(input.aiHomeDir);
  const harnessIds = Array.isArray(input.harnessIds) && input.harnessIds.length
    ? input.harnessIds.map((id) => normalizeText(id).toLowerCase()).filter(Boolean)
    : listRefreshableHarnesses();
  const connection = input.connection || {};
  const baseUrl = normalizeText(connection.baseUrl).replace(/\/+$/, '');
  const apiKey = normalizeText(connection.apiKey);
  if (!aiHomeDir) return { ok: false, error: 'ai_home_dir_missing', results: [] };
  if (!baseUrl || !apiKey) return { ok: false, error: 'gateway_connection_missing', results: [] };

  const withDirs = harnessIds.filter((harnessId) => {
    if (!HARNESS_MODEL_PROJECTIONS[harnessId]) return false;
    return listProjectionDirs(fsImpl, pathImpl, aiHomeDir, harnessId).dirs.length > 0;
  });
  if (!withDirs.length) return { ok: true, error: 'no_projection_dirs', results: [] };

  let catalog;
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
      error: 'gateway_catalog_unavailable',
      message: String(error && error.message || error),
      results: []
    };
  }

  const results = [];
  for (const harnessId of withDirs) {
    results.push(await refreshHarnessModelProjections({ ...input, harnessId, catalog }));
  }
  return { ok: results.every((result) => result.ok), results };
}

module.exports = {
  HARNESS_MODEL_PROJECTIONS,
  listRefreshableHarnesses,
  mergeModelsPreservingMetadata,
  refreshAllHarnessModelProjections,
  refreshHarnessModelProjections
};
