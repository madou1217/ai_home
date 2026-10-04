'use strict';

// 上游 WAF/CDN 拦截页不是凭据失效；只接受 POST 的推理端点不把 GET 转发上游。
// 事故：GET /v1/messages → codex 上游 Cloudflare 403 HTML → 两个健康 OAuth 号被判 auth_invalid 冷却一年。

const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyUpstreamFailure } = require('../lib/server/upstream-failure-policy');
const { applyAccountFailurePolicy } = require('../lib/server/account-runtime-state');
const { rejectNonPostInference } = require('../lib/server/v1-method-guard');
const { startClaudeServer } = require('./helpers/plugin-gateway-harness');

const CLOUDFLARE_PAGE = '<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title></head><body>cf challenge</body></html>';
const oauthAccount = { accountRef: 'acct_edge_oauth', authType: 'oauth' };

test('a Cloudflare HTML 403 is an edge block, not an invalid credential', () => {
  const policy = classifyUpstreamFailure({
    provider: 'codex',
    statusCode: 403,
    headers: new Headers({ 'content-type': 'text/html; charset=UTF-8', 'cf-ray': 'a455e65de9d080ef-NRT' }),
    body: CLOUDFLARE_PAGE,
    detail: 'upstream_403_account_acct_edge_oauth',
    account: oauthAccount,
    defaultCooldownMs: 60000
  });
  assert.equal(policy.kind, 'upstream_edge_blocked');
  assert.equal(policy.shouldMarkFailure, false);
  assert.equal(policy.shouldRetryAnotherAccount, false, '换号只会得到同一张拦截页');
  assert.equal(policy.cooldownMs, 0);
  assert.equal(policy.scope, 'none');

  const marked = [];
  applyAccountFailurePolicy({ ...oauthAccount }, policy, { markProxyAccountFailure: (...args) => marked.push(args), defaultThreshold: 1 });
  assert.deepEqual(marked, [], '账号状态不受影响');
});

test('cf-mitigated marks an edge block even with a JSON body; plain-object headers work too', () => {
  for (const headers of [new Headers({ 'cf-mitigated': 'challenge' }), { 'CF-Mitigated': 'challenge' }]) {
    const policy = classifyUpstreamFailure({ provider: 'claude', statusCode: 403, headers, body: '{"error":"blocked"}', detail: 'x', account: oauthAccount });
    assert.equal(policy.kind, 'upstream_edge_blocked');
  }
});

test('genuine JSON 401/403 auth failures still lock the account as before', () => {
  for (const statusCode of [401, 403]) {
    const policy = classifyUpstreamFailure({
      provider: 'codex',
      statusCode,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: '{"error":{"message":"Your authentication token has been invalidated.","code":"token_invalidated"}}',
      detail: `upstream_${statusCode}`,
      account: oauthAccount,
      defaultCooldownMs: 60000
    });
    assert.equal(policy.kind, 'auth_invalid');
    assert.equal(policy.failureReason, 'auth_invalid_reauth_required');
    assert.equal(policy.shouldMarkFailure, true);
  }
  const noHeaders = classifyUpstreamFailure({ provider: 'codex', statusCode: 401, detail: 'upstream_401', account: oauthAccount });
  assert.equal(noHeaders.kind, 'auth_invalid', '没有响应头与正文时维持原判定');
});

test('GET/HEAD on POST-only inference paths are refused locally; OPTIONS and other paths pass', () => {
  const calls = [];
  const res = { headers: {}, setHeader(name, value) { this.headers[name] = value; } };
  const writeJson = (target, status, payload) => calls.push({ status, payload, allow: target.headers.Allow });
  for (const pathname of ['/v1/messages', '/v1/chat/completions', '/v1/responses', '/v1/messages/count_tokens']) {
    assert.equal(rejectNonPostInference({ method: 'GET', pathname, res, writeJson }), true, pathname);
  }
  assert.equal(rejectNonPostInference({ method: 'HEAD', pathname: '/v1/messages', res, writeJson }), true);
  assert.equal(rejectNonPostInference({ method: 'OPTIONS', pathname: '/v1/messages', res, writeJson }), false);
  assert.equal(rejectNonPostInference({ method: 'GET', pathname: '/v1/models', res, writeJson }), false);
  assert.equal(rejectNonPostInference({ method: 'POST', pathname: '/v1/messages', res, writeJson }), false);
  assert.ok(calls.every((call) => call.status === 405 && call.allow === 'POST' && call.payload.error === 'method_not_allowed'));
});

test('through aih server: GET /v1/messages gets 405 and never reaches an upstream account', async (t) => {
  const server = await startClaudeServer(t);
  const response = await fetch(`${server.base}/v1/messages`, { headers: { 'x-api-key': 'test-client-key' } });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'POST');
  assert.deepEqual(server.upstreamTokens, [], '上游零命中');
  const ok = await server.message('claude-opus-5', 'still works');
  assert.equal(ok.status, 200);
});

test('through aih server: a 403 HTML edge block ends the request without refreshing, rotating or locking accounts', async (t) => {
  const server = await startClaudeServer(t);
  server.failures.edgeBlocks = 1;
  const blocked = await server.message('claude-opus-5', 'blocked');
  assert.equal(blocked.status, 502, await blocked.clone().text());
  assert.match(await blocked.text(), /edge_blocked/);
  assert.equal(server.upstreamTokens.length, 1, '不换号、不刷新后重试');
  // 选号是随机的：被拦截的那个账号如果没被锁，20 次内几乎必然再次被选中（锁了则永远不会）。
  const blockedToken = server.upstreamTokens[0];
  let reused = false;
  for (let index = 0; index < 20 && !reused; index += 1) {
    const ok = await server.message('claude-opus-5', `after ${index}`);
    assert.equal(ok.status, 200, await ok.text());
    reused = server.upstreamTokens[server.upstreamTokens.length - 1] === blockedToken;
  }
  assert.equal(reused, true, '被拦截的账号仍可调度（没有被锁）');
});
