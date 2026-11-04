'use strict';

// 回归守卫（2026-11-04 账号 1 真机）：app-server turn 报
//   ClientRequestSigningV4Error: Client signing requires an API Key or Project Access Token
// 根因不是模型/额度，而是 requestAuth.apiKey 送了**业务 access token**。coding-plan
// 账号的 provider 会走 ClientRequestSigningV4，签名器只认：
//   * JWT payload 带 `api_key` 的 Project Access Token；或
//   * `apiKeyId.secret` 形态的 API Key。
// 正确做法与桌面端 AccountProviderRequestAuthService 一致：
//   定位 org/project/apiKey → POST …/api_keys/<id>/access_tokens 换取 PAT。
// 本用例锁住三条分叉：start-plan 直送 zcode JWT（不请求网络）、
// PAT 直用（无网络）、coding-plan 必须走定位 + 签发。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildZcodeAccountScope,
  parseProjectAccessTokenIdentity,
  resolveZcodeProviderRequestAuth
} = require('../lib/cli/services/ai-cli/zcode-app-server-run');
const {
  buildZcodeProjectKeyLocationKey,
  resolveZcodeProjectAccessToken
} = require('../lib/server/zcode-project-key-location');

function base64Url(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function makeJwt(payload) {
  return `${base64Url({ alg: 'HS256', typ: 'JWT' })}.${base64Url(payload)}.sig`;
}

function jsonResponse(body, { status = 200, ok = true } = {}) {
  return {
    ok,
    status,
    text: async () => JSON.stringify(body)
  };
}

function locationKey(overrides = {}) {
  return buildZcodeProjectKeyLocationKey({
    origin: 'https://bigmodel.cn',
    family: 'bigmodel',
    accountId: '23701694489963901',
    personalProjectSelection: 'non-team',
    ...overrides
  });
}

const OAUTH = Object.freeze({
  activeProvider: 'bigmodel',
  accessToken: 'business-access-token',
  jwtToken: 'zcode-jwt-token',
  userInfo: { id: '23701694489963901' }
});

test('parseProjectAccessTokenIdentity 只认 payload.api_key（业务 token 返回 null）', () => {
  const pat = makeJwt({ api_key: '28f08a4c' });
  assert.deepEqual(parseProjectAccessTokenIdentity(pat), { apiKeyId: '28f08a4c' });
  assert.equal(parseProjectAccessTokenIdentity(makeJwt({ user_id: 1, user_key: 'x' })), null);
  assert.equal(parseProjectAccessTokenIdentity('business-access-token'), null);
});

test('start-plan 直送 zcode JWT，不做任何网络请求', async () => {
  let calls = 0;
  const result = await resolveZcodeProviderRequestAuth({
    planMode: 'start-plan',
    oauth: OAUTH,
    request: async () => {
      calls += 1;
      throw new Error('should not request');
    }
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.auth, { apiKey: 'zcode-jwt-token' });
  assert.equal(calls, 0);
});

test('access_token 本身已是 PAT 时直接使用（无网络）', async () => {
  const pat = makeJwt({ api_key: 'key-from-pat' });
  let calls = 0;
  const result = await resolveZcodeProviderRequestAuth({
    planMode: 'individual-coding-plan',
    oauth: { ...OAUTH, accessToken: pat },
    request: async () => {
      calls += 1;
      throw new Error('should not request');
    }
  });
  assert.equal(result.ok, true);
  assert.equal(result.auth.apiKey, pat);
  assert.equal(result.auth.apiKeyId, 'key-from-pat');
  assert.equal(typeof result.auth.accountScope, 'string');
  assert.equal(calls, 0);
});

test('coding-plan 用已缓存定位签发 PAT（Authorization: Bearer 登录态）', async () => {
  const calls = [];
  const pat = makeJwt({ api_key: 'cached-key' });
  const result = await resolveZcodeProviderRequestAuth({
    planMode: 'individual-coding-plan',
    oauth: OAUTH,
    plainCredentials: {
      [locationKey()]: JSON.stringify({
        organizationId: 'org-1',
        projectId: 'proj-1',
        apiKeyId: 'cached-key'
      })
    },
    clientVersion: '0.17.1',
    request: async (url, init) => {
      calls.push({ url, init });
      return jsonResponse({
        code: 0,
        data: { enabled: true, accessToken: pat, tokenType: 'Bearer', expiresIn: 18000, expiresAt: 1793799812 }
      });
    }
  });
  assert.equal(result.ok, true);
  assert.equal(result.auth.apiKey, pat);
  assert.equal(result.auth.apiKeyId, 'cached-key');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/api\/biz\/v1\/organization\/org-1\/projects\/proj-1\/api_keys\/cached-key\/access_tokens$/);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer business-access-token');
  assert.equal(JSON.parse(calls[0].init.body).clientVersion, '0.17.1');
});

test('定位缺失时先 getCustomerInfo → 列 api_keys，再签发 PAT（bigmodel 用裸 token）', async () => {
  const calls = [];
  const pat = makeJwt({ api_key: 'project-key' });
  const responses = [
    jsonResponse({
      code: 0,
      data: {
        customerNumber: '23701694489963901',
        organizations: [{
          organizationId: 'org-9',
          organizationName: '默认机构',
          projects: [{ projectId: 'proj-9', projectName: '默认项目', projectType: 1 }]
        }]
      }
    }),
    jsonResponse({ code: 0, data: [{ name: 'zcode-api-key', apiKey: 'project-key' }] }),
    jsonResponse({ code: 0, data: { enabled: true, accessToken: pat, expiresIn: 100, expiresAt: 1793799812 } })
  ];
  const result = await resolveZcodeProviderRequestAuth({
    planMode: 'individual-coding-plan',
    oauth: OAUTH,
    plainCredentials: {},
    request: async (url, init) => {
      calls.push({ url, init });
      return responses.shift();
    }
  });
  assert.equal(result.ok, true);
  assert.equal(result.auth.apiKey, pat);
  assert.equal(result.auth.apiKeyId, 'project-key');
  assert.equal(calls.length, 3);
  assert.match(calls[0].url, /\/api\/biz\/customer\/getCustomerInfo$/);
  assert.equal(calls[0].init.headers.Authorization, 'business-access-token');
  assert.match(calls[1].url, /\/organization\/org-9\/projects\/proj-9\/api_keys$/);
  assert.equal(calls[1].init.headers.Authorization, 'business-access-token');
  assert.match(calls[2].url, /\/api_keys\/project-key\/access_tokens$/);
  assert.equal(calls[2].init.headers.Authorization, 'Bearer business-access-token');
});

test('签发被禁用时返回可读错误码（不把裸 token 当 PAT 回给 CLI）', async () => {
  const result = await resolveZcodeProviderRequestAuth({
    planMode: 'individual-coding-plan',
    oauth: OAUTH,
    plainCredentials: {
      [locationKey()]: JSON.stringify({
        organizationId: 'org-1',
        projectId: 'proj-1',
        apiKeyId: 'cached-key'
      })
    },
    request: async () => jsonResponse({ code: 0, data: { enabled: false } })
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'project_token_disabled');
});

test('resolveZcodeProjectAccessToken 失败时返回 null 并上报原因', async () => {
  const observed = [];
  const material = await resolveZcodeProjectAccessToken({
    origin: 'https://bigmodel.cn',
    loginToken: 'login-token',
    organizationId: 'org',
    projectId: 'proj',
    apiKeyId: 'key',
    request: async () => jsonResponse({ code: 401, msg: 'token expired' }),
    observe: (event) => observed.push(event && event.code)
  });
  assert.equal(material, null);
  assert.deepEqual(observed, ['project_token_request_failed']);
});

test('团队套餐用 accountAccess 的 org/project 定位（不拿个人项目 token 冒充）', async () => {
  const teamKey = buildZcodeProjectKeyLocationKey({
    origin: 'https://bigmodel.cn',
    family: 'bigmodel',
    accountId: '23701694489963901',
    team: { organizationId: 'org-team', projectId: 'proj-team' }
  });
  const calls = [];
  const pat = makeJwt({ api_key: 'team-key' });
  const result = await resolveZcodeProviderRequestAuth({
    planMode: 'team-coding-plan',
    oauth: OAUTH,
    team: { organizationId: 'org-team', projectId: 'proj-team' },
    plainCredentials: {
      [locationKey()]: JSON.stringify({
        organizationId: 'org-personal',
        projectId: 'proj-personal',
        apiKeyId: 'personal-key'
      }),
      [teamKey]: JSON.stringify({
        organizationId: 'org-team',
        projectId: 'proj-team',
        apiKeyId: 'team-key'
      })
    },
    request: async (url, init) => {
      calls.push({ url, init });
      return jsonResponse({ code: 0, data: { enabled: true, accessToken: pat, expiresIn: 100, expiresAt: 1793799812 } });
    }
  });
  assert.equal(result.ok, true);
  assert.equal(result.auth.apiKey, pat);
  assert.equal(result.auth.apiKeyId, 'team-key');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/organization\/org-team\/projects\/proj-team\/api_keys\/team-key\/access_tokens$/);
});

test('团队套餐没有缓存定位时如实报错（不回落个人项目）', async () => {
  let calls = 0;
  const result = await resolveZcodeProviderRequestAuth({
    planMode: 'team-coding-plan',
    oauth: OAUTH,
    team: { organizationId: 'org-team', projectId: 'proj-team' },
    plainCredentials: {
      [locationKey()]: JSON.stringify({
        organizationId: 'org-personal',
        projectId: 'proj-personal',
        apiKeyId: 'personal-key'
      })
    },
    request: async () => {
      calls += 1;
      throw new Error('should not request');
    }
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'project_token_location_unresolved');
  assert.equal(calls, 0);
});

test('accountScope 对同一登录态稳定、登录态变化时变化', () => {
  const a = buildZcodeAccountScope({ family: 'bigmodel', planMode: 'individual-coding-plan', oauth: OAUTH });
  const b = buildZcodeAccountScope({ family: 'bigmodel', planMode: 'individual-coding-plan', oauth: OAUTH });
  const c = buildZcodeAccountScope({
    family: 'bigmodel',
    planMode: 'individual-coding-plan',
    oauth: { ...OAUTH, accessToken: 'rotated' }
  });
  assert.match(a, /^[a-f0-9]{64}$/);
  assert.equal(a, b);
  assert.notEqual(a, c);
});
