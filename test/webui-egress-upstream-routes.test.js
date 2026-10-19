'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { handleEgressUpstreamRequest, matchEgressUpstreamRoute } = require('../lib/server/webui-egress-upstream-routes');
const { readUpstreamEvidence, recordUpstreamEvidence, readUpstreamPolicy } = require('../lib/server/egress-region-policy');
const { redactProxy } = require('../lib/server/egress-upstream-view');

function ctxFor(home, method, pathname, body, extra = {}) {
  const out = {};
  return {
    out,
    ctx: {
      method,
      pathname,
      fs,
      aiHomeDir: home,
      url: new URL(`http://x${pathname}${extra.query || ''}`),
      options: {},
      state: { accounts: { claude: [{ provider: 'claude', accountRef: 'c1', cliAccountId: '3', email: 'a@example.com' }] } },
      readRequestBody: async () => Buffer.from(body ? JSON.stringify(body) : ''),
      writeJson: (_res, status, payload) => { out.status = status; out.payload = payload; },
      res: {}
    }
  };
}

test('route matching', () => {
  assert.equal(matchEgressUpstreamRoute('GET', '/v0/webui/egress-upstreams'), true);
  assert.equal(matchEgressUpstreamRoute('PUT', '/v0/webui/egress-upstreams/api.anthropic.com'), true);
  assert.equal(matchEgressUpstreamRoute('POST', '/v0/webui/egress-upstreams/api.anthropic.com/probe'), true);
  assert.equal(matchEgressUpstreamRoute('POST', '/v0/webui/egress-upstreams/api.anthropic.com/evidence/reset'), true);
  assert.equal(matchEgressUpstreamRoute('POST', '/v0/webui/egress-upstreams/network/refresh'), true);
  assert.equal(matchEgressUpstreamRoute('DELETE', '/v0/webui/egress-upstreams/x'), false);
});

test('GET lists upstreams with accounts, hints and network verdicts; PUT/reset round-trip', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-upstream-routes-'));
  try {
    let { ctx, out } = ctxFor(home, 'GET', '/v0/webui/egress-upstreams');
    await handleEgressUpstreamRequest(ctx);
    assert.equal(out.status, 200);
    const upstream = out.payload.upstreams[0];
    assert.equal(upstream.official, true);
    assert.ok(upstream.hints.length > 0 && upstream.hints[0].source);
    assert.equal(upstream.accounts[0].label, '#3 a@example.com');
    assert.equal(upstream.unboundCount, 1);
    assert.ok(upstream.accounts[0].network, 'unbound account carries a network verdict');

    ({ ctx, out } = ctxFor(home, 'PUT', `/v0/webui/egress-upstreams/${encodeURIComponent(upstream.id)}`, {
      rules: [{ effect: 'deny', match: { city: ['Hong Kong'] }, note: 'HK 不可用' }],
      evidenceTtlMs: 3600000
    }));
    await handleEgressUpstreamRequest(ctx);
    assert.equal(out.status, 200);
    const policy = readUpstreamPolicy(fs, home, upstream.id);
    assert.deepEqual(policy.rules[0].match.city, ['hong kong']);
    assert.equal(policy.evidenceTtlMs, 3600000);

    recordUpstreamEvidence(fs, home, upstream.id, 'node:a', { status: 'blocked' });
    recordUpstreamEvidence(fs, home, upstream.id, 'node:b', { status: 'ok' });
    ({ ctx, out } = ctxFor(home, 'POST', `/v0/webui/egress-upstreams/${encodeURIComponent(upstream.id)}/evidence/reset`, { exitKeys: ['node:a'] }));
    await handleEgressUpstreamRequest(ctx);
    assert.deepEqual([out.status, out.payload.removed], [200, 1]);
    assert.deepEqual(Object.keys(readUpstreamEvidence(fs, home, upstream.id)), ['node:b']);

    ({ ctx, out } = ctxFor(home, 'POST', '/v0/webui/egress-upstreams/unknown.example/evidence/reset', {}));
    await handleEgressUpstreamRequest(ctx);
    assert.equal(out.status, 404);
    ({ ctx, out } = ctxFor(home, 'POST', `/v0/webui/egress-upstreams/${encodeURIComponent(upstream.id)}/probe`, {}));
    await handleEgressUpstreamRequest(ctx);
    assert.equal(out.status, 409, 'probing needs the pool');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('proxy credentials are redacted in the view', () => {
  assert.equal(redactProxy('http://user:secret@1.2.3.4:8080'), 'http://***:***@1.2.3.4:8080');
  assert.equal(redactProxy('socks5://1.2.3.4:1080'), 'socks5://1.2.3.4:1080');
});
