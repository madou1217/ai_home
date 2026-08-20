'use strict';

function sanitizeBaseState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return {};
  const { status: _operationalStatus, ...baseState } = state;
  return baseState;
}

module.exports = {
  sanitizeBaseState
};
