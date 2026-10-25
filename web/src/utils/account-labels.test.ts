import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getAccountIdentityLabel,
  getAccountSecondaryIdentity,
  isInternalAccountLabel
} from './account-labels.ts';

const baseAccount = {
  provider: 'workbuddy' as const,
  email: 'user@example.com',
  displayName: '',
  configured: true,
  apiKeyMode: false,
  baseUrl: '',
  authPendingStale: false
};

test('UUID display names never replace the real email or appear as a secondary identity', () => {
  const account = { ...baseAccount, displayName: '409f887f-b00d-4c65-be21-123456789abc' };

  assert.equal(getAccountIdentityLabel(account), 'user@example.com');
  assert.equal(getAccountSecondaryIdentity(account), '');
  assert.equal(isInternalAccountLabel(account.displayName), true);
});

test('UUID-only OAuth accounts fall back to a stable generic label', () => {
  const account = {
    ...baseAccount,
    email: '',
    displayName: '409f887f-b00d-4c65-be21-123456789abc'
  };

  assert.equal(getAccountIdentityLabel(account), '账号待识别');
});

test('real identity wins when a provider puts its UUID in the email field', () => {
  const account = {
    ...baseAccount,
    email: '409f887f-b00d-4c65-be21-123456789abc',
    displayName: 'madou1217@gmail.com'
  };

  assert.equal(getAccountIdentityLabel(account), 'madou1217@gmail.com');
  assert.equal(getAccountSecondaryIdentity(account), '');
});
