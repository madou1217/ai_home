'use strict';

function orderModelRouteSources(input = {}) {
  const hasAlias = Boolean(input.hasAlias);
  const hasNative = Boolean(input.hasNative);
  if (!hasAlias) return hasNative ? ['native'] : [];
  if (!hasNative) return ['alias'];

  const cursors = input.cursors && typeof input.cursors === 'object'
    ? input.cursors
    : {};
  const cursorKey = String(input.cursorKey || 'alias-native').trim() || 'alias-native';
  const cursor = Math.max(0, Number(cursors[cursorKey]) || 0);
  cursors[cursorKey] = (cursor + 1) % 2;
  return cursor % 2 === 0 ? ['alias', 'native'] : ['native', 'alias'];
}

module.exports = {
  orderModelRouteSources
};
