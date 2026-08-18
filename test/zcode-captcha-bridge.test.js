'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createZcodeCaptchaBridge,
  isZcodeCaptchaRequiredErrorBody
} = require('../lib/server/zcode-captcha-bridge');

const CAPTCHA_CONFIG_BODY = {
  data: {
    configs: {
      captcha: {
        enabled: true,
        region: 'cn',
        prefix: 'abcd',
        sceneId: 'scene-1'
      }
    }
  }
};

function createConfigFetch(body = CAPTCHA_CONFIG_BODY, tracker = null) {
  return async (url, init, timeoutMs) => {
    if (tracker) tracker(url, init, timeoutMs);
    return {
      ok: true,
      json: async () => body
    };
  };
}

function createBridge(overrides = {}) {
  const broadcasts = [];
  const bridge = createZcodeCaptchaBridge({
    fetchWithTimeout: createConfigFetch(),
    broadcast: (payload) => {
      broadcasts.push(payload);
      return overrides.listenerCount === undefined ? 1 : overrides.listenerCount;
    },
    ...overrides.deps
  });
  return { bridge, broadcasts };
}

test('isZcodeCaptchaRequiredErrorBody matches code 3007 and captcha message', () => {
  assert.equal(isZcodeCaptchaRequiredErrorBody('{"code":3007,"msg":"captcha verify failed"}'), true);
  assert.equal(isZcodeCaptchaRequiredErrorBody('{"code": 3007}'), true);
  assert.equal(isZcodeCaptchaRequiredErrorBody('captcha verify failed'), true);
  assert.equal(isZcodeCaptchaRequiredErrorBody('{"code":3001,"msg":"rate limited"}'), false);
  assert.equal(isZcodeCaptchaRequiredErrorBody(''), false);
  assert.equal(isZcodeCaptchaRequiredErrorBody(null), false);
});

test('getCaptchaConfig caches the config and de-dupes concurrent fetches', async () => {
  let fetchCalls = 0;
  const bridge = createZcodeCaptchaBridge({
    fetchWithTimeout: async () => {
      fetchCalls += 1;
      return { ok: true, json: async () => CAPTCHA_CONFIG_BODY };
    },
    broadcast: () => 1
  });

  const [first, second, third] = await Promise.all([
    bridge.getCaptchaConfig(),
    bridge.getCaptchaConfig(),
    bridge.getCaptchaConfig()
  ]);
  assert.deepEqual(first, { region: 'cn', prefix: 'abcd', sceneId: 'scene-1' });
  assert.deepEqual(second, first);
  assert.deepEqual(third, first);
  assert.equal(fetchCalls, 1, 'single-flight + cache: only one upstream fetch');
});

test('getCaptchaConfig returns null when captcha disabled or fields missing', async () => {
  const disabled = createZcodeCaptchaBridge({
    fetchWithTimeout: createConfigFetch({ data: { configs: { captcha: { enabled: false, region: 'cn', prefix: 'p', sceneId: 's' } } } }),
    broadcast: () => 1
  });
  assert.equal(await disabled.getCaptchaConfig(), null);

  const missing = createZcodeCaptchaBridge({
    fetchWithTimeout: createConfigFetch({ data: { configs: { captcha: { enabled: true, region: '', prefix: 'p', sceneId: 's' } } } }),
    broadcast: () => 1
  });
  assert.equal(await missing.getCaptchaConfig(), null);

  const httpError = createZcodeCaptchaBridge({
    fetchWithTimeout: async () => ({ ok: false, json: async () => ({}) }),
    broadcast: () => 1
  });
  assert.equal(await httpError.getCaptchaConfig(), null);
});

test('requestVerification broadcasts the challenge and complete resolves it', async () => {
  const { bridge, broadcasts } = createBridge();
  const pending = bridge.requestVerification('acct_a', { timeoutMs: 5000 });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(broadcasts.length, 1);
  assert.equal(broadcasts[0].type, 'zcode-captcha');
  assert.equal(broadcasts[0].state, 'required');
  const challenge = broadcasts[0].challenge;
  assert.equal(challenge.accountRef, 'acct_a');
  assert.equal(challenge.sceneId, 'scene-1');

  assert.deepEqual(bridge.listPending().map((item) => item.id), [challenge.id]);
  const completeResult = bridge.complete(challenge.id, { verifyParam: 'verify-param-1' });
  assert.equal(completeResult.ok, true);

  const result = await pending;
  assert.deepEqual(result, {
    ok: true,
    verifyParam: 'verify-param-1',
    region: 'cn',
    userAgent: '',
    secChUa: '',
    secChUaPlatform: '',
    secChUaMobile: '',
    acceptLanguage: ''
  });
  // complete 后广播 resolved 让 WebUI 清理 UI。
  assert.equal(broadcasts[1].state, 'resolved');
  assert.deepEqual(bridge.listPending(), []);
});

test('requestVerification times out and broadcasts expired', async () => {
  const { bridge, broadcasts } = createBridge();
  const result = await bridge.requestVerification('acct_timeout', { timeoutMs: 30 });
  assert.deepEqual(result, { ok: false, reason: 'captcha_timeout' });
  assert.equal(broadcasts[1].state, 'expired');
  assert.deepEqual(bridge.listPending(), []);
});

test('dismiss rejects the pending verification', async () => {
  const { bridge } = createBridge();
  const pending = bridge.requestVerification('acct_dismiss', { timeoutMs: 5000 });
  await new Promise((resolve) => setImmediate(resolve));
  const challenge = bridge.listPending()[0];
  assert.equal(bridge.dismiss(challenge.id).ok, true);
  assert.deepEqual(await pending, { ok: false, reason: 'dismissed' });
  assert.deepEqual(bridge.listPending(), []);
});

test('complete consumes the verify param: only the earliest waiter gets it', async () => {
  const { bridge, broadcasts } = createBridge();
  const first = bridge.requestVerification('acct_concurrent', { timeoutMs: 5000 });
  await new Promise((resolve) => setImmediate(resolve));
  const second = bridge.requestVerification('acct_concurrent', { timeoutMs: 5000 });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(broadcasts.length, 1, 'concurrent same-account requests share one challenge broadcast');
  const challenge = bridge.listPending()[0];
  bridge.complete(challenge.id, { verifyParam: 'one-shot-param' });

  assert.deepEqual(await first, {
    ok: true,
    verifyParam: 'one-shot-param',
    region: 'cn',
    userAgent: '',
    secChUa: '',
    secChUaPlatform: '',
    secChUaMobile: '',
    acceptLanguage: ''
  });
  assert.deepEqual(await second, { ok: false, reason: 'captcha_consumed' });
  assert.deepEqual(bridge.listPending(), []);
});

test('requestVerification fails fast when no WebUI listener is connected', async () => {
  const { bridge, broadcasts } = createBridge({ listenerCount: 0 });
  const result = await bridge.requestVerification('acct_alone', { timeoutMs: 5000 });
  assert.deepEqual(result, { ok: false, reason: 'no_webui_listener' });
  assert.deepEqual(bridge.listPending(), []);
  assert.equal(broadcasts.length, 1, 'the required broadcast is what detects the missing listener');
});

test('requestVerification reports captcha_config_unavailable without config', async () => {
  const bridge = createZcodeCaptchaBridge({
    fetchWithTimeout: async () => ({ ok: true, json: async () => ({ data: { configs: {} } }) }),
    broadcast: () => 1
  });
  const result = await bridge.requestVerification('acct_noconfig', { timeoutMs: 5000 });
  assert.deepEqual(result, { ok: false, reason: 'captcha_config_unavailable' });
});

test('complete rejects unknown challenges and missing verify params', async () => {
  const { bridge } = createBridge();
  assert.deepEqual(bridge.complete('zc_missing', { verifyParam: 'x' }), { ok: false, reason: 'unknown_challenge' });

  const pending = bridge.requestVerification('acct_param', { timeoutMs: 5000 });
  await new Promise((resolve) => setImmediate(resolve));
  const challenge = bridge.listPending()[0];
  assert.deepEqual(bridge.complete(challenge.id, { verifyParam: '' }), { ok: false, reason: 'missing_verify_param' });
  bridge.dismiss(challenge.id);
  await pending;
});
