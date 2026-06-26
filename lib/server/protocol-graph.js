'use strict';

function normalizeProtocolId(value) {
  return String(value || '').trim();
}

function indexProtocolEdges(edges, options = {}) {
  const sourceKey = options.sourceKey || 'sourceProtocol';
  const targetKey = options.targetKey || 'targetProtocol';
  const index = new Map();
  (Array.isArray(edges) ? edges : []).forEach((edge) => {
    if (!edge || typeof edge !== 'object') return;
    const source = normalizeProtocolId(edge[sourceKey]);
    const target = normalizeProtocolId(edge[targetKey]);
    if (!source || !target) return;
    if (!index.has(source)) index.set(source, []);
    index.get(source).push(edge);
  });
  return index;
}

function resolveProtocolPath(edges, sourceProtocol, targetProtocol, options = {}) {
  const sourceKey = options.sourceKey || 'sourceProtocol';
  const targetKey = options.targetKey || 'targetProtocol';
  const source = normalizeProtocolId(sourceProtocol);
  const target = normalizeProtocolId(targetProtocol);
  if (!source || !target) return null;
  if (source === target) return [];

  const edgeIndex = indexProtocolEdges(edges, { sourceKey, targetKey });
  const queue = [{ protocol: source, path: [] }];
  const visited = new Set([source]);

  while (queue.length > 0) {
    const current = queue.shift();
    const nextEdges = edgeIndex.get(current.protocol) || [];
    for (const edge of nextEdges) {
      const nextProtocol = normalizeProtocolId(edge[targetKey]);
      if (!nextProtocol || visited.has(nextProtocol)) continue;
      const path = [...current.path, edge];
      if (nextProtocol === target) return path;
      visited.add(nextProtocol);
      queue.push({ protocol: nextProtocol, path });
    }
  }
  return null;
}

module.exports = {
  indexProtocolEdges,
  normalizeProtocolId,
  resolveProtocolPath
};
