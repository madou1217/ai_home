'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { getPublicAccountRef } = require('../lib/account/public-account-ref');
const {
  createCodexAppServerAccountIdentityValidator
} = require('../lib/server/codex-app-server-account-identity');
const {
  DEFAULT_CODEX_EMAIL,
  DEFAULT_CODEX_USER_ID,
  codexAccountRef,
  codexOAuthAuth
} = require('./codex-identity-fixtures');

// accountRef 现在从 `oauth:codex:<user_id>` 派生，不再是邮箱
// （docs/architecture/codex-oauth-identity-vector-adr.md）。凭据必须带一个含用户 ID 的
// ID Token，否则身份不可验证。
function oauthFixture(overrides = {}) {
  const email = overrides.email || DEFAULT_CODEX_EMAIL;
  const userId = overrides.userId === undefined ? DEFAULT_CODEX_USER_ID : overrides.userId;
  const auth = overrides.auth || codexOAuthAuth({ userId, email });
  const accountRef = overrides.accountRef || codexAccountRef(userId);
  const runtimeDir = path.join('/tmp', 'aih-codex-identity', accountRef);
  const validator = createCodexAppServerAccountIdentityValidator({
    accountRef,
    aiHomeDir: '/tmp/aih-codex-identity',
    platform: 'darwin',
    getProfileDir: () => runtimeDir,
    gatewayPinnedProvider: overrides.gatewayPinnedProvider === true,
    readAccountCredentialRecord: () => ({
      accountRef,
      provider: 'codex',
      env: {},
      nativeAuth: { auth }
    })
  });
  return { accountRef, auth, email, userId, runtimeDir, validator };
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
      // 凭据本身是完好的（含用户 ID），失败必须来自「它不属于这个 accountRef」，
      // 而不是来自身份不可验证——否则这条测试会因为错的原因通过。
      nativeAuth: { auth: fixture.auth }
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

test('identity validator fails closed when the credential carries no stable user id', async () => {
  // 邮箱不是身份。改动前这里会用邮箱派生出一个 accountRef 并放行；现在必须拒绝，
  // 因为按邮箱派生的账号会在邮箱变更时改写 accountRef（§8.1 明文禁止）。
  const fixture = oauthFixture({
    auth: codexOAuthAuth({ userId: null, email: 'native@example.com' })
  });

  await assert.rejects(
    fixture.validator({
      initializeResult: { codexHome: path.join(fixture.runtimeDir, '.codex') },
      accountResult: { account: { type: 'chatgpt', email: fixture.email } }
    }),
    (error) => {
      assert.equal(error.code, 'codex_account_identity_unavailable');
      assertErrorDoesNotExpose(error, [fixture.email, 'secret-token']);
      return true;
    }
  );
});

// 被 aih 钉在本机网关（-c model_provider=aih_server）的 app-server 按 codex 契约不自报账号。
// 这四条的重点不是「新分支能过」，而是**收窄之后闸门还咬得住**。
test('gateway-pinned OAuth app-server verifies by runtime home when codex reports no account', async () => {
  const fixture = oauthFixture({ gatewayPinnedProvider: true });

  const verified = await fixture.validator({
    initializeResult: { codexHome: path.join(fixture.runtimeDir, '.codex') },
    accountResult: { account: null, requiresOpenaiAuth: false }
  });

  assert.equal(verified.verified, true);
  assert.equal(verified.kind, 'oauth');
  assert.equal(verified.assurance, 'runtime-home');
  assert.match(verified.identityHash, /^[a-f0-9]{64}$/);
  assert.match(verified.runtimeHomeHash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(verified).includes(fixture.email), false);
  assert.equal(JSON.stringify(verified).includes('secret-token'), false);
});

test('gateway-pinned validator still fails closed where the account binding could be forged', async (t) => {
  const fixture = oauthFixture({ gatewayPinnedProvider: true });
  const matchingHome = { codexHome: path.join(fixture.runtimeDir, '.codex') };
  const cases = [
    {
      // 没登录的原生 app-server 同样不报账号，而 codexHome 照样匹配（那就是我们自己的投影目录）。
      // 放行条件必须是合取，否则这一条会被当成钉网关而整道闸门失效。
      name: 'not signed in',
      input: { initializeResult: matchingHome, accountResult: { account: null, requiresOpenaiAuth: true } },
      code: 'codex_app_server_account_identity_missing'
    },
    {
      // 家目录是钉网关形态下唯一的账号绑定，它必须仍然是硬判据。
      name: 'foreign runtime home',
      input: {
        initializeResult: { codexHome: '/tmp/host/.codex' },
        accountResult: { account: null, requiresOpenaiAuth: false }
      },
      code: 'codex_app_server_runtime_home_mismatch'
    },
    {
      // 对方真报了账号就按强判据核对，绝不因为「声明过钉网关」而退到弱判据。
      name: 'foreign chatgpt account reported anyway',
      input: {
        initializeResult: matchingHome,
        accountResult: { account: { type: 'chatgpt', email: 'other@example.com' }, requiresOpenaiAuth: false }
      },
      code: 'codex_app_server_account_identity_mismatch'
    }
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      await assert.rejects(fixture.validator(scenario.input), (error) => {
        assert.equal(error.code, scenario.code);
        assertErrorDoesNotExpose(error, [fixture.email, 'secret-token']);
        return true;
      });
    });
  }
});

// reset-credit 的 stdio app-server 只对自带 OPENAI_API_KEY 的 api-key 账号中转，OAuth 账号仍连
// 官方 provider、必然自报 chatgpt —— 那条路上空账号就是异常，严判据必须继续拒绝。
test('unpinned OAuth app-server keeps rejecting an empty account', async () => {
  const fixture = oauthFixture();

  await assert.rejects(
    fixture.validator({
      initializeResult: { codexHome: path.join(fixture.runtimeDir, '.codex') },
      accountResult: { account: null, requiresOpenaiAuth: false }
    }),
    (error) => error.code === 'codex_app_server_account_type_mismatch'
  );
});
