'use strict';

const crypto = require('node:crypto');

const ACCOUNT_REF_PREFIX = 'acct_';
const ACCOUNT_REF_HASH_LENGTH = 20;

function getPublicAccountRef(identityKey) {
  const value = String(identityKey || '').trim();
  if (!value) return '';
  const digest = crypto.createHash('sha256').update(value).digest('hex').slice(0, ACCOUNT_REF_HASH_LENGTH);
  return `${ACCOUNT_REF_PREFIX}${digest}`;
}

function getPublicAccountRefSuffix(identityKey) {
  const accountRef = getPublicAccountRef(identityKey);
  return accountRef.startsWith(ACCOUNT_REF_PREFIX)
    ? accountRef.slice(ACCOUNT_REF_PREFIX.length)
    : '';
}

function isAccountRef(value) {
  return new RegExp(`^${ACCOUNT_REF_PREFIX}[a-f0-9]{${ACCOUNT_REF_HASH_LENGTH}}$`).test(String(value || '').trim());
}

module.exports = {
  ACCOUNT_REF_HASH_LENGTH,
  ACCOUNT_REF_PREFIX,
  getPublicAccountRef,
  getPublicAccountRefSuffix,
  isAccountRef
};
