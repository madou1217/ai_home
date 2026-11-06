'use strict';

// 账号视图的影子对账：Node 的账号页投影 vs Go 的账号事实。
//
// 为什么先做对账而不是直接切：账号页有 43 行而 Go 只有 35 个账号，
// 差额是 Node-only Provider（gemini）与未同步的账号。直接切会让这些账号从页面消失，
// 必须先看清差集、确认每一行都有解释，才谈前门翻转。
//
// 字段级的判据集中在 account-row-sources 的来源表里：装配口径（diffAccountRow）
// 与投影时效（diffProjectedRow）各管一段，这里只负责按翻译后的 ref 对齐两侧。

const { isDeepStrictEqual } = require('node:util');

const { assembleAccountRow, diffAccountRow, diffProjectedRow } = require('./account-row-sources');

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

// collectFieldMismatches 把两条判据的结果摊平成同一张差异表：
//   diffAccountRow   —— 装配口径（Go 有值且语义等价的字段，翻转后由 Go 覆盖）
//   diffProjectedRow —— 投影时效（Go 计算、Node 直读的额度快照是否同一份）
function collectFieldMismatches(key, nodeRow, goRow, out) {
  for (const diff of diffAccountRow(nodeRow, goRow)) {
    out.push({ accountRef: key, ...diff });
  }
  for (const diff of diffProjectedRow(nodeRow, goRow)) {
    out.push({ accountRef: key, ...diff });
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
  // assembledChanged 是切片 C 的「装配不改行」守卫：用来源表把 Go 事实叠回 Node 行，
  // 结果必须与线上行逐字段相同。有变化说明 Go 与 Node 对同一列给出了不同结论，
  // 前门翻转后页面就会变——必须在翻之前归零。
  let assembledChanged = 0;
  for (const [key, nodeRow] of nodeIndex) {
    const goRow = goIndex.get(key);
    if (!goRow) {
      nodeOnly.push({ accountRef: key, provider: String(nodeRow.provider || '') });
      continue;
    }
    collectFieldMismatches(key, nodeRow, goRow, fieldMismatch);
    if (!isDeepStrictEqual(assembleAccountRow(nodeRow, goRow), nodeRow)) assembledChanged += 1;
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
      && fieldMismatch.length === 0 && assembledChanged === 0,
    nodeCount: nodeIndex.size,
    goCount: goIndex.size,
    nodeOnly,
    goOnly,
    providerMismatch,
    enabledMismatch,
    fieldMismatch,
    assembledChanged
  };
}

module.exports = { compareAccountSets };
