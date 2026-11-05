'use strict';

// 别名投影的影子对账：Node 是 owner，Go 里有一份落库副本。
//
// 为什么要有它：切片 B/C 要把所有权翻到 Go，翻转前必须证明两边在真实使用下长时间一致。
// 这里只做只读比较，不改变任何返回——先把漂移数据攒出来，再谈切流。
//
// 比较口径：以 (alias, provider) 为键（别名解析按作用域选候选，同名的不同作用域是两条记录），
// 逐项比较 target / targetProvider / priority / enabled / description。

function aliasKey(record) {
  const alias = String(record && record.alias || '').trim();
  const provider = String(record && record.provider || 'all').trim() || 'all';
  return provider + '\u0000' + alias;
}

function normalize(record) {
  const enabled = record && record.enabled;
  return {
    target: String(record && record.target || '').trim(),
    targetProvider: String(record && record.targetProvider || 'auto').trim() || 'auto',
    priority: Number(record && record.priority) || 0,
    // 未声明按启用处理，与 Node normalizeAliasRecord 一致。
    enabled: enabled === undefined || enabled === null ? true : enabled !== false,
    description: String(record && record.description || '').trim()
  };
}

// compareAliasSets 返回 missing（仅 Node 有）/ extra（仅 Go 有）/ changed（键相同但字段不同）。
function compareAliasSets(nodeAliases, goAliases) {
  const nodeIndex = new Map();
  const goIndex = new Map();
  for (const record of Array.isArray(nodeAliases) ? nodeAliases : []) {
    nodeIndex.set(aliasKey(record), record);
  }
  for (const record of Array.isArray(goAliases) ? goAliases : []) {
    goIndex.set(aliasKey(record), record);
  }
  const missing = [];
  const changed = [];
  for (const [key, nodeRecord] of nodeIndex) {
    if (!goIndex.has(key)) {
      missing.push(nodeRecord.alias);
      continue;
    }
    const left = normalize(nodeRecord);
    const right = normalize(goIndex.get(key));
    const fields = Object.keys(left).filter((field) => left[field] !== right[field]);
    if (fields.length > 0) {
      changed.push({ alias: nodeRecord.alias, fields });
    }
  }
  const extra = [];
  for (const [key, goRecord] of goIndex) {
    if (!nodeIndex.has(key)) extra.push(goRecord.alias);
  }
  return {
    equal: missing.length === 0 && extra.length === 0 && changed.length === 0,
    missing,
    extra,
    changed
  };
}

module.exports = { compareAliasSets, aliasKey };

