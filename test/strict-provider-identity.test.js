'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { resolveNativeAuthIdentitySeed, resolveIdentitySeedFromAccount } = require('../lib/account/account-identity');
const { buildOAuthIdentity } = require('../lib/account/transfer-core');
const { parseIdentityObject, decodeIdentityJwt } = require('../lib/account/identity-subject');
const { createKiroIdentityEvidence } = require('../lib/account/kiro-identity');
const { resolveKiroIdentityEvidence } = require('../lib/account/kiro-identity-probe');

const hash = value => crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
const jwt = value => `e30.${Buffer.from(JSON.stringify(value)).toString('base64url')}.signature`;
const seed = (provider, native) => resolveNativeAuthIdentitySeed(provider, native).identitySeed;

for (const provider of ['kimi', 'codebuddy', 'codebuddycn', 'workbuddy', 'workbuddycn']) {
  test(`${provider}: email and rotating secrets cannot displace a stable subject`, () => {
    const before = { user_id: 'User-A', email: 'before@example.invalid', access_token: jwt({ sub: 'User-A' }), refresh_token: 'old' };
    const after = { ...before, email: 'changed@example.invalid', refresh_token: 'new' };
    const expected = `oauth:${provider}:user:${hash('User-A')}`;
    assert.equal(seed(provider, { credentials: before }), expected);
    assert.equal(seed(provider, { credentials: after }), expected);
    assert.equal(buildOAuthIdentity(provider, after), expected);
    assert.equal(seed(provider, { credentials: { ...before, userId: 'different' } }), '');
    assert.equal(seed(provider, { credentials: { email: before.email, access_token: 'opaque', refresh_token: 'opaque' } }), '');
  });
}

test('Zcode prefers the corroborated user ID and rejects malformed embedded identity JSON', () => {
  const credentials = { 'oauth:zai:user_info': JSON.stringify({ user_id: 'zcode-A', email: 'display@example.invalid' }), zcodejwttoken: jwt({ sub: 'zcode-A' }) };
  assert.equal(seed('zcode', { credentials }), `oauth:zcode:user:${hash('zcode-A')}`);
  assert.equal(seed('zcode', { credentials: { ...credentials, 'oauth:zai:user_info': '{"user_id":"one","user_id":"zcode-A"}' } }), '');
  assert.equal(seed('zcode', { credentials: { ...credentials, zcodejwttoken: jwt({ sub: 'other-user' }) } }), '');
  assert.equal(seed('zcode', { credentials: { zcodejwttoken: 'opaque', 'oauth:zai:user_info': '{"email":"only@example.invalid"}' } }), '');
});

test('OpenCode preserves the legitimate static key vector, scopes OAuth by upstream/type, and rejects partial identity sets', () => {
  const staticAuth = { anthropic: { type: 'api', key: 'fixture-key' } };
  assert.equal(seed('opencode', { auth: staticAuth }), `oauth:opencode:auth:${hash(`anthropic:api:key:${hash('fixture-key')}`)}`);
  const oauth = { anthropic: { type: 'oauth', account_id: 'User-A', email: 'ignored@example.invalid', refresh: 'first' } };
  const expected = `oauth:opencode:auth:${hash('anthropic:oauth:id:User-A')}`;
  assert.equal(seed('opencode', { auth: oauth }), expected);
  assert.equal(seed('opencode', { auth: { anthropic: { ...oauth.anthropic, refresh: 'second', email: 'changed@example.invalid' } } }), expected);
  assert.equal(seed('opencode', { auth: { ...oauth, unknown: { type: 'oauth', refresh: 'opaque' } } }), '');
  assert.equal(seed('opencode', { auth: { ...oauth, Anthropic: oauth.anthropic } }), '');
});

for (const provider of ['qoder', 'qodercn']) test(`${provider}: display labels cannot replace UID`, () => {
  const userInfo = { uid: 'qoder-A', email: 'before@example.invalid', security_oauth_token: 'first' };
  assert.equal(seed(provider, { userInfo }), `oauth:${provider}:uid:qoder-A`);
  assert.equal(seed(provider, { userInfo: { ...userInfo, email: 'changed@example.invalid', security_oauth_token: 'new' } }), `oauth:${provider}:uid:qoder-A`);
  assert.equal(seed(provider, { userInfo: { ...userInfo, user_id: 'foreign' } }), '');
  assert.equal(seed(provider, { userInfo: { email: userInfo.email, security_oauth_token: 'opaque' } }), '');
});

test('an account display descriptor cannot resurrect retired email identity fallbacks', () => {
  for (const provider of ['codex', 'claude', 'grok', 'opencode', 'kimi', 'kiro', 'zcode', 'qoder', 'codebuddy']) {
    assert.equal(resolveIdentitySeedFromAccount({ provider, email: 'display@example.invalid' }).identitySeed, '');
  }
});

test('identity JSON rejects duplicate escaped keys and JWT rejects malformed shape', () => {
  assert.equal(parseIdentityObject('{"sub":"one","s\\u0075b":"two"}'), null);
  assert.equal(parseIdentityObject('{"outer":{"user_id":"one","user_id":"two"}}'), null);
  assert.deepEqual(parseIdentityObject('{"array":["a:b","{not an object}",{"key":"ok"}]}'), { array: ['a:b', '{not an object}', { key: 'ok' }] });
  assert.equal(decodeIdentityJwt('header.body'), null);
  assert.equal(decodeIdentityJwt('e30.e30=.signature'), null);
});

test('Kiro accepts evidence bound to the current grant; refreshed evidence retains the same subject identity', () => {
  const auth = { access_token: 'first-access', refresh_token: 'first-refresh', region: 'us-east-1' };
  const response = { userInfo: { userId: 'aws-user-A', email: 'display@example.invalid' } };
  const identityEvidence = createKiroIdentityEvidence(auth, response, 1000);
  const first = seed('kiro', { auth, identityEvidence });
  assert.match(first, /^oauth:kiro:user:[a-f0-9]{16}$/);
  const rotated = { ...auth, access_token: 'second-access', refresh_token: 'second-refresh' };
  assert.equal(seed('kiro', { auth: rotated, identityEvidence }), '');
  assert.equal(seed('kiro', { auth: rotated, identityEvidence: createKiroIdentityEvidence(rotated, response, 2000) }), first);
  assert.equal(seed('kiro', { auth }), '');
  assert.equal(seed('kiro', { auth, identityEvidence: { ...identityEvidence, endpoint: 'https://attacker.invalid' } }), '');
});

test('Kiro enrichment follows the pinned AWS wire contract and never stores the email', async () => {
  const native = { auth: { access_token: 'fixture-access', refresh_token: 'fixture-refresh', region: 'us-east-1' } };
  const evidence = await resolveKiroIdentityEvidence(native, {
    now: () => 1000,
    request: async (url, options) => {
      assert.equal(new URL(url).origin, 'https://codewhisperer.us-east-1.amazonaws.com');
      assert.equal(options.method, 'POST');
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers['x-amz-target'], 'AmazonCodeWhispererService.GetUsageLimits');
      assert.equal(options.headers.authorization, 'Bearer fixture-access');
      return new Response(JSON.stringify({ userInfo: { userId: 'aws-A', email: 'discard@example.invalid' } }), { status: 200 });
    }
  });
  assert.equal(evidence.subject, 'aws-A');
  assert.equal(JSON.stringify(evidence).includes('discard@example.invalid'), false);
  assert.ok(seed('kiro', { ...native, identityEvidence: evidence }));
});

test('Kiro rejects response/credential races and does not echo server or network error bodies', async () => {
  const native = { auth: { access_token: 'fixture-access', refresh_token: 'fixture-refresh' } };
  await assert.rejects(resolveKiroIdentityEvidence(native, { request: async () => {
    native.auth.access_token = 'changed';
    return new Response('{"userInfo":{"userId":"aws-A"}}');
  } }), { code: 'kiro_identity_credential_changed' });
  await assert.rejects(resolveKiroIdentityEvidence(native, { request: async () => {
    throw new Error('secret-token-must-not-leak');
  } }), error => error.code === 'kiro_identity_transport_failed' && !error.message.includes('secret-token'));
  await assert.rejects(resolveKiroIdentityEvidence(native, { request: async () => new Response('sensitive-body', { status: 403 }) }), { code: 'kiro_identity_access_denied' });
  await assert.rejects(resolveKiroIdentityEvidence(native, { request: async () => new Response('{"userInfo":{"userId":"one","userId":"two"}}') }), { code: 'kiro_identity_unverifiable' });
});
