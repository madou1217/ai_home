'use strict';

const PROVIDER_ACCOUNT_REF_ENV = 'AIH_PROVIDER_ACCOUNT_REF';
const ACCOUNT_APP_MARKER_ENV = 'AIH_ACCOUNT_APP';

function normalizeProviderAccountRef(value) {
  const accountRef = String(value || '').trim();
  return /^acct_[a-f0-9]{20}$/.test(accountRef) ? accountRef : '';
}

module.exports = {
  ACCOUNT_APP_MARKER_ENV,
  PROVIDER_ACCOUNT_REF_ENV,
  normalizeProviderAccountRef
};
