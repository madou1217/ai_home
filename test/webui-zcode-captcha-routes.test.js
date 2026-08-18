'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { handleWebUiZcodeCaptchaRoutes } = require('../lib/server/webui-zcode-captcha-routes');
const { createZcodeCaptchaBridge } = require('../lib/server/zcode-captcha-bridge');

function createResCapture() {
  return {
    statusCode: 0,
    body: '',
    setHeader() {},
    end(chunk = '') { this.body = String(chunk); },
    write(chunk = '') { this.body += String(chunk); }
  };
}

function createRouteCtx(overrides = {}) {
  const bridge = createZcodeCaptchaBridge({
    fetchWithTimeout: async () => ({
      ok: true,
      json: async () => ({
        data: { configs: { captcha: { enabled: true, region: 'cn', prefix: 'p', sceneId: 's' } } }
      })
    }),
    broadcast: () => 1
  });
  return {
    bridge,
    ctx: {
      method: overrides.method || 'GET',
      pathname: overrides.pathname || '/v0/webui/zcode-captcha/pending',
      req: {},
      res: overrides.res,
      writeJson: (res, code, payload) => {
        res.statusCode = code;
        res.end(JSON.stringify(payload));
      },
      readRequestBody: overrides.readRequestBody || (async () => Buffer.from('')),
      deps: { zcodeCaptchaBridge: overrides.withoutBridge ? null : bridge }
    }
  };
}

test('GET pending lists challenges for page reload recovery', async () => {
  const res = createResCapture();
  const { bridge, ctx } = createRouteCtx({ res });
  const pending = bridge.requestVerification('acct_route', { timeoutMs: 5000 });
  await new Promise((resolve) => setImmediate(resolve));

  const handled = await handleWebUiZcodeCaptchaRoutes(ctx);
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const payload = JSON.parse(res.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.challenges.length, 1);
  assert.equal(payload.challenges[0].accountRef, 'acct_route');

  bridge.dismiss(payload.challenges[0].id);
  await pending;
});

test('POST complete resolves the pending verification', async () => {
  const res = createResCapture();
  const { bridge, ctx } = createRouteCtx({ res });
  const pending = bridge.requestVerification('acct_route_complete', { timeoutMs: 5000 });
  await new Promise((resolve) => setImmediate(resolve));
  const challenge = bridge.listPending()[0];

  const handled = await handleWebUiZcodeCaptchaRoutes({
    ...ctx,
    method: 'POST',
    pathname: `/v0/webui/zcode-captcha/${challenge.id}/complete`,
    readRequestBody: async () => Buffer.from(JSON.stringify({ verifyParam: 'param-1', region: 'cn' }))
  });
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(await pending, {
    ok: true,
    verifyParam: 'param-1',
    region: 'cn',
    userAgent: '',
    secChUa: '',
    secChUaPlatform: '',
    secChUaMobile: '',
    acceptLanguage: ''
  });
});

test('POST complete forwards solver browser identity headers to the waiter', async () => {
  const res = createResCapture();
  const { bridge, ctx } = createRouteCtx({ res });
  const pending = bridge.requestVerification('acct_route_ua', { timeoutMs: 5000 });
  await new Promise((resolve) => setImmediate(resolve));
  const challenge = bridge.listPending()[0];

  const handled = await handleWebUiZcodeCaptchaRoutes({
    ...ctx,
    method: 'POST',
    pathname: `/v0/webui/zcode-captcha/${challenge.id}/complete`,
    req: {
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0.0.0',
        'sec-ch-ua': '"Chromium";v="126"',
        'sec-ch-ua-platform': '"Windows"',
        'sec-ch-ua-mobile': '?0',
        'accept-language': 'zh-CN,zh;q=0.9'
      }
    },
    readRequestBody: async () => Buffer.from(JSON.stringify({ verifyParam: 'param-ua', region: 'cn' }))
  });
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(await pending, {
    ok: true,
    verifyParam: 'param-ua',
    region: 'cn',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0.0.0',
    secChUa: '"Chromium";v="126"',
    secChUaPlatform: '"Windows"',
    secChUaMobile: '?0',
    acceptLanguage: 'zh-CN,zh;q=0.9'
  });
});

test('POST dismiss rejects the pending verification', async () => {
  const res = createResCapture();
  const { bridge, ctx } = createRouteCtx({ res });
  const pending = bridge.requestVerification('acct_route_dismiss', { timeoutMs: 5000 });
  await new Promise((resolve) => setImmediate(resolve));
  const challenge = bridge.listPending()[0];

  const handled = await handleWebUiZcodeCaptchaRoutes({
    ...ctx,
    method: 'POST',
    pathname: `/v0/webui/zcode-captcha/${challenge.id}/dismiss`
  });
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(await pending, { ok: false, reason: 'dismissed' });
});

test('complete validates the verify param and unknown challenges 404', async () => {
  const res = createResCapture();
  const { bridge, ctx } = createRouteCtx({ res });
  const pending = bridge.requestVerification('acct_route_invalid', { timeoutMs: 5000 });
  await new Promise((resolve) => setImmediate(resolve));
  const challenge = bridge.listPending()[0];

  const missingParam = createResCapture();
  await handleWebUiZcodeCaptchaRoutes({
    ...ctx,
    method: 'POST',
    pathname: `/v0/webui/zcode-captcha/${challenge.id}/complete`,
    res: missingParam,
    readRequestBody: async () => Buffer.from(JSON.stringify({ verifyParam: '' }))
  });
  assert.equal(missingParam.statusCode, 400);
  assert.equal(JSON.parse(missingParam.body).error, 'missing_verify_param');

  const unknown = createResCapture();
  await handleWebUiZcodeCaptchaRoutes({
    ...ctx,
    method: 'POST',
    pathname: '/v0/webui/zcode-captcha/zc_unknown/complete',
    res: unknown,
    readRequestBody: async () => Buffer.from(JSON.stringify({ verifyParam: 'x' }))
  });
  assert.equal(unknown.statusCode, 404);
  assert.equal(JSON.parse(unknown.body).error, 'unknown_challenge');

  bridge.dismiss(challenge.id);
  await pending;
});

test('routes report 503 when the bridge is not wired', async () => {
  const res = createResCapture();
  const { ctx } = createRouteCtx({ res, withoutBridge: true });
  const handled = await handleWebUiZcodeCaptchaRoutes(ctx);
  assert.equal(handled, true);
  assert.equal(res.statusCode, 503);
  assert.equal(JSON.parse(res.body).error, 'zcode_captcha_bridge_unavailable');
});

test('unrelated paths are not handled', async () => {
  const res = createResCapture();
  const { ctx } = createRouteCtx({ res, pathname: '/v0/webui/accounts' });
  const handled = await handleWebUiZcodeCaptchaRoutes(ctx);
  assert.equal(handled, false);
});
