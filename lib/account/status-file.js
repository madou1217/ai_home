'use strict';

function normalizeAccountStatusValue(status) {
  const value = String(status || '').trim().toLowerCase();
  if (value === 'down' || value === 'disabled') return 'down';
  if (value === 'up' || value === 'enabled') return 'up';
  return '';
}

function resolveEffectiveAccountStatus(persistedStatus) {
  return normalizeAccountStatusValue(persistedStatus) || 'up';
}

module.exports = {
  normalizeAccountStatusValue,
  resolveEffectiveAccountStatus
};
