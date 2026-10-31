'use strict';

/**
 * 通配别名（如 `claude-*`）在模型目录里的展开。
 *
 * 通配别名能接住任意以前缀开头的模型名，但客户端不能把 `claude-*` 当模型名发，
 * 于是 /v1/models 此前直接丢掉它们：本地接入远端网关时完全看不到「claude-* 能代替
 * 哪些模型」。这里从 models.dev 离线快照里挑出该前缀下的**常见型号**来展示：
 *
 * - 按 family（claude-opus / claude-sonnet …）分组，每组只取最新 GENERATIONS_PER_FAMILY 代；
 * - 发布超过 MAX_RELEASE_AGE_MS 的一律不显示（不展示早已过期的模型）；
 * - 带日期后缀的快照 ID（`claude-opus-4-5-20251101`）与其别名重复，去掉。
 *
 * 只决定「列出哪些名字」，不碰路由：请求时仍由通配别名本身解析目标。
 */

const GENERATIONS_PER_FAMILY = 3;
const MAX_RELEASE_AGE_MS = 365 * 24 * 60 * 60 * 1000;
const DATED_SNAPSHOT_SUFFIX = /-\d{8}$/;

let cachedRows = null;

function loadSnapshotRows() {
  if (cachedRows) return cachedRows;
  let snapshot = null;
  try {
    // eslint-disable-next-line global-require
    snapshot = require('./models-dev-snapshot').loadModelsDevSnapshot();
  } catch (_error) {
    snapshot = null;
  }
  const models = snapshot && snapshot.models && typeof snapshot.models === 'object' ? snapshot.models : {};
  const byId = new Map();
  Object.values(models).forEach((model) => {
    const fullId = String(model && model.id || '').trim();
    // 顶层注册表的 ID 带 vendor 前缀（`anthropic/claude-opus-5-5`）；客户端发的是裸名。
    const id = fullId.includes('/') ? fullId.slice(fullId.lastIndexOf('/') + 1) : fullId;
    const releasedAt = Date.parse(String(model && model.release_date || ''));
    if (!id || !Number.isFinite(releasedAt)) return;
    // 别名替的是聊天模型：生图、实时语音、转写这类非文本输出或不支持工具调用的不进列表。
    const output = model && model.modalities && Array.isArray(model.modalities.output) ? model.modalities.output : [];
    if (output.length !== 1 || output[0] !== 'text' || model.tool_call !== true) return;
    const existing = byId.get(id);
    if (existing && existing.releasedAt >= releasedAt) return;
    byId.set(id, {
      id,
      family: String(model && model.family || '').trim() || id,
      releasedAt
    });
  });
  cachedRows = Array.from(byId.values());
  return cachedRows;
}

/**
 * 某个通配前缀下应展示的模型 ID，按 family 内新到旧、family 间按最新发布排序。
 *
 * @param {string} pattern 通配别名，必须以单个 `*` 结尾
 * @param {{ now?: number, rows?: Array<{id: string, family: string, releasedAt: number}> }} [options]
 */
function listWildcardAliasModels(pattern, options = {}) {
  const alias = String(pattern || '').trim();
  if (!alias.endsWith('*')) return [];
  const prefix = alias.slice(0, -1);
  if (prefix.length < 2 || prefix.includes('*')) return [];
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const rows = Array.isArray(options.rows) ? options.rows : loadSnapshotRows();

  const families = new Map();
  rows.forEach((row) => {
    if (!row || !String(row.id).startsWith(prefix)) return;
    if (DATED_SNAPSHOT_SUFFIX.test(row.id)) return;
    if (now - row.releasedAt > MAX_RELEASE_AGE_MS) return;
    if (!families.has(row.family)) families.set(row.family, []);
    families.get(row.family).push(row);
  });

  const groups = Array.from(families.values()).map((items) => items
    .sort((a, b) => (b.releasedAt - a.releasedAt) || a.id.localeCompare(b.id))
    .slice(0, GENERATIONS_PER_FAMILY));
  groups.sort((a, b) => (b[0].releasedAt - a[0].releasedAt) || a[0].family.localeCompare(b[0].family));
  return groups.flat().map((row) => row.id);
}

module.exports = {
  GENERATIONS_PER_FAMILY,
  MAX_RELEASE_AGE_MS,
  listWildcardAliasModels
};
