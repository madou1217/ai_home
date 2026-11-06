'use strict';

// 账号视图的影子对账：Node 的账号页投影 vs Go 的账号事实。
//
// 为什么先做对账而不是直接切：账号页有 43 行而 Go 只有 35 个账号，
// 差额是 Node-only Provider（gemini）与未同步的账号。直接切会让这些账号从页面消失，
// 必须先看清差集、确认每一行都有解释，才谈前门翻转。
//
// 只比「可判定」的字段：accountRef、provider、enabled。模型数、剩余额度在两侧口径
// 不同（Node 的 modelCount 可能是 null），先不纳入。

function normalizeRef(value) {
  return String(value || '').trim();
}

function accountKey(record, translate) {
  // Node 行是 camelCase，Go 的管理接口是 snake_case，两种都要认。
  const raw = normalizeRef(record && (record.accountRef || record.account_ref));
  if (!raw) return '';
  const translated = typeof translate === 'function' ? translate(raw) : '';
  return normalizeRef(translated) || raw;
}

function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}

function toMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = String(value || '').trim();
  if (!text) return 0;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

// collectFieldMismatches 只比「两侧都有值」的可判定字段，以及快照的有无。
//
// 为什么不全比：Go 的 account_profiles 是 Provider 派生身份（见方案 3.5），
// display_name/email 本来就为空，比了只会制造假警。这里只比两侧同源的两项：
// auth_mode（都来自 Node 的账号状态）与额度快照（Node 推文档给 Go）。
function collectFieldMismatches(key, nodeRow, goRow, out) {
  const nodeAuthMode = normalizeText(nodeRow.authMode);
  const goAuthMode = normalizeText(goRow.auth_mode);
  if (nodeAuthMode && goAuthMode && nodeAuthMode !== goAuthMode) {
    out.push({ accountRef: key, field: 'auth_mode', node: nodeAuthMode, go: goAuthMode });
  }

  const nodeSnapshot = nodeRow.usageSnapshot && typeof nodeRow.usageSnapshot === 'object'
    ? nodeRow.usageSnapshot
    : null;
  const goSnapshot = goRow.usage_snapshot && typeof goRow.usage_snapshot === 'object'
    ? goRow.usage_snapshot
    : null;
  if (!nodeSnapshot && !goSnapshot) return;
  if (!nodeSnapshot || !goSnapshot) {
    out.push({
      accountRef: key,
      field: 'usage_snapshot',
      node: nodeSnapshot ? 'present' : 'missing',
      go: goSnapshot ? 'present' : 'missing'
    });
    return;
  }
  const nodeCapturedAt = toMs(nodeSnapshot.capturedAt);
  const goCapturedAt = toMs(goSnapshot.captured_at);
  if (nodeCapturedAt && goCapturedAt && Math.abs(nodeCapturedAt - goCapturedAt) > 1000) {
    out.push({
      accountRef: key,
      field: 'usage_captured_at',
      node: nodeCapturedAt,
      go: goCapturedAt
    });
  }
}

// compareAccountSets 按翻译后的 accountRef 对齐，输出三类差异。
function compareAccountSets(nodeRows, goRows, translate) {
  const nodeIndex = new Map();
  const goIndex = new Map();
  (Array.isArray(nodeRows) ? nodeRows : []).forEach((row) => {
    const key = accountKey(row, translate);
    if (key) nodeIndex.set(key, row);
  });
  (Array.isArray(goRows) ? goRows : []).forEach((row) => {
    const key = accountKey(row, null);
    if (key) goIndex.set(key, row);
  });

  const nodeOnly = [];
  const providerMismatch = [];
  const enabledMismatch = [];
  const fieldMismatch = [];
  for (const [key, nodeRow] of nodeIndex) {
    const goRow = goIndex.get(key);
    if (!goRow) {
      nodeOnly.push({ accountRef: key, provider: String(nodeRow.provider || '') });
      continue;
    }
    collectFieldMismatches(key, nodeRow, goRow, fieldMismatch);
    const nodeProvider = String(nodeRow.provider || '').toLowerCase();
    const goProvider = String(goRow.provider_id || goRow.provider || '').toLowerCase();
    if (nodeProvider && goProvider && nodeProvider !== goProvider) {
      providerMismatch.push({ accountRef: key, node: nodeProvider, go: goProvider });
    }
    // Vertex 占位账号在 Go 里被刻意置为 enabled=false（go-account-sync.js:533：
    // vertexPlaceholder ? false : record.status !== 'down'）。Node 页面按 status 显示 up，
    // 这不是分歧而是设计——不排除的话影子对账会一直报假警。
    const placeholder = String(goRow.auth_kind || '').toLowerCase() === 'vertex_ai';
    // Node 用 status（up/down）；Go 用 enabled。down 等价于 enabled=false。
    if (!placeholder && typeof goRow.enabled === 'boolean' && nodeRow.status) {
      const nodeEnabled = String(nodeRow.status).toLowerCase() !== 'down';
      if (nodeEnabled !== goRow.enabled) {
        enabledMismatch.push({ accountRef: key, nodeEnabled, goEnabled: goRow.enabled });
      }
    }
  }
  const goOnly = [];
  for (const [key, goRow] of goIndex) {
    if (!nodeIndex.has(key)) {
      goOnly.push({ accountRef: key, provider: String(goRow.provider_id || goRow.provider || '') });
    }
  }
  return {
    equal: nodeOnly.length === 0 && goOnly.length === 0
      && providerMismatch.length === 0 && enabledMismatch.length === 0
      && fieldMismatch.length === 0,
    nodeCount: nodeIndex.size,
    goCount: goIndex.size,
    nodeOnly,
    goOnly,
    providerMismatch,
    enabledMismatch,
    fieldMismatch
  };
}

module.exports = { compareAccountSets };
