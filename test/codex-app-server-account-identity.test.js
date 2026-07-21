'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { getPublicAccountRef } = require('../lib/account/public-account-ref');
const {
  createCodexAppServerAccountIdentityValidator
} = require('../lib/server/codex-app-server-account-identity');

function oauthFixture(overrides = {}) {
  const email = overrides.email || 'native@example.com';
  const accountRef = getPublicAccountRef(`unique:oauth:codex:${email}`);
  const runtimeDir = path.join('/tmp', 'aih-codex-identity', accountRef);
  const validator = createCodexAppServerAccountIdentityValidator({
    accountRef,
    aiHomeDir: '/tmp/aih-codex-identity',
    platform: 'darwin',
    getProfileDir: () => runtimeDir,
    readAccountCredentialRecord: () => ({
      accountRef,
      provider: 'codex',
      env: {},
      nativeAuth: { auth: { email, tokens: { access_token: 'secret-token' } } }
    })
  });
  return { accountRef, email, runtimeDir, validator };
}

function assertErrorDoesNotExpose(error, sensitiveValues) {
  const surfaces = [
    error && error.message,
    error && error.stack,
    error && error.details === undefined ? '' : JSON.stringify(error.details)
  ].map((value) => String(value || ''));
  for (const sensitiveValue of sensitiveValues) {
    assert.equal(
      surfaces.some((surface) => surface.includes(sensitiveValue)),
      false,
      `error exposed sensitive value: ${sensitiveValue}`
    );
  }
}

test('OAuth identity validator accepts matching account and ignores mutable plan type', async () => {
  const fixture = oauthFixture();

  const verified = await fixture.validator({
    initializeResult: { codexHome: path.join(fixture.runtimeDir, '.codex') },
    accountResult: {
      account: { type: 'chatgpt', email: 'NATIVE@example.com', planType: 'team' },
      requiresOpenaiAuth: false
    }
  });

  assert.equal(verified.verified, true);
  assert.equal(verified.kind, 'oauth');
  assert.equal(verified.assurance, 'identity');
  assert.match(verified.identityHash, /^[a-f0-9]{64}$/);
  assert.match(verified.runtimeHomeHash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(verified).includes(fixture.email), false);
  assert.equal(JSON.stringify(verified).includes('secret-token'), false);
});

test('OAuth identity validator fails closed for wrong home, type, email, or empty account', async (t) => {
  const fixture = oauthFixture();
  const cases = [
    {
      name: 'wrong home',
      initializeResult: { codexHome: '/tmp/host/.codex' },
      accountResult: { account: { type: 'chatgpt', email: fixture.email } }
    },
    {
      name: 'wrong type',
      initializeResult: { codexHome: path.join(fixture.runtimeDir, '.codex') },
      accountResult: { account: { type: 'apiKey' } }
    },
    {
      name: 'wrong email',
      initializeResult: { codexHome: path.join(fixture.runtimeDir, '.codex') },
      accountResult: { account: { type: 'chatgpt', email: 'other@example.com' } }
    },
    {
      name: 'empty account',
      initializeResult: { codexHome: path.join(fixture.runtimeDir, '.codex') },
      accountResult: { account: null }
    }
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      await assert.rejects(
        fixture.validator(scenario),
        (error) => {
          assert.match(error.code, /^codex_app_server_/);
          assertErrorDoesNotExpose(error, [fixture.email, 'secret-token']);
          return true;
        }
      );
    });
  }
});

test('identity validator accepts the native account/read shape for an API-key execution credential', async () => {
  const apiKey = 'sk-sensitive-value';
  const accountRef = 'acct_11111111111111111111';
  const validator = createCodexAppServerAccountIdentityValidator({
    accountRef,
    aiHomeDir: '/tmp/aih-codex-identity',
    readAccountCredentialRecord: () => ({
      accountRef,
      provider: 'codex',
      env: { OPENAI_API_KEY: apiKey },
      nativeAuth: {}
    })
  });

  const verified = await validator({
    initializeResult: { codexHome: '/tmp/host/.codex' },
    accountResult: { account: null, requiresOpenaiAuth: false }
  });

  assert.equal(verified.verified, true);
  assert.equal(verified.kind, 'api-key');
  assert.equal(verified.assurance, 'execution-credential');
  assert.equal(JSON.stringify(verified).includes(apiKey), false);
});

test('identity validator rejects a ChatGPT account for an API-key execution credential', async () => {
  const validator = createCodexAppServerAccountIdentityValidator({
    accountRef: 'acct_11111111111111111111',
    aiHomeDir: '/tmp/aih-codex-identity',
    readAccountCredentialRecord: () => ({
      accountRef: 'acct_11111111111111111111',
      provider: 'codex',
      env: { OPENAI_API_KEY: 'sk-sensitive-value' },
      nativeAuth: {}
    })
  });

  await assert.rejects(
    validator({
      initializeResult: { codexHome: '/tmp/host/.codex' },
      accountResult: {
        account: { type: 'chatgpt', email: 'foreign@example.com' },
        requiresOpenaiAuth: false
      }
    }),
    (error) => error.code === 'codex_app_server_account_type_mismatch'
  );
});

test('identity validator rejects a credential record bound to a foreign accountRef', async () => {
  const fixture = oauthFixture();
  const validator = createCodexAppServerAccountIdentityValidator({
    accountRef: 'acct_22222222222222222222',
    aiHomeDir: '/tmp/aih-codex-identity',
    getProfileDir: () => fixture.runtimeDir,
    readAccountCredentialRecord: () => ({
      provider: 'codex',
      env: {},
      nativeAuth: { auth: { email: fixture.email } }
    })
  });

  await assert.rejects(
    validator({
      initializeResult: { codexHome: path.join(fixture.runtimeDir, '.codex') },
      accountResult: { account: { type: 'chatgpt', email: fixture.email } }
    }),
    (error) => error.code === 'codex_account_identity_local_mismatch'
  );
});
