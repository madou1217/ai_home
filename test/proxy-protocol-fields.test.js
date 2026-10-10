'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { FIELD_VALIDATORS } = require('../lib/cli/services/toolkit/proxy-pool/protocol-fields');
const { PROTOCOL_PLUGINS } = require('../lib/cli/services/toolkit/proxy-pool/protocols');
const {
  buildProxyNodeConnectionKey,
  validateProxyNodeInput
} = require('../lib/cli/services/toolkit/proxy-pool/proxy-node-store');

function rejects(node, pattern) {
  assert.throws(() => validateProxyNodeInput(node), pattern, JSON.stringify(node));
}

test('every protocol plugin declares typed fields and only requires declared ones', () => {
  for (const plugin of PROTOCOL_PLUGINS) {
    assert.ok(plugin.fields && typeof plugin.fields === 'object', plugin.id);
    for (const [field, type] of Object.entries(plugin.fields)) {
      assert.ok(FIELD_VALIDATORS[type], `${plugin.id}.${field}: ${type}`);
    }
    for (const field of plugin.required || []) {
      assert.ok(Object.hasOwn(plugin.fields, field), `${plugin.id} requires undeclared ${field}`);
    }
  }
});

test('the node store validates protocol fields from the plugin declaration', () => {
  assert.deepEqual(
    validateProxyNodeInput({ protocol: 'ss', server: 'a.example', port: 8388, cipher: 'aes-128-gcm', password: 'p' }),
    { protocol: 'shadowsocks', server: 'a.example', port: 8388 }
  );
  // 声明在 TLS 字段组里的 uTLS 指纹对 trojan 同样合法。
  validateProxyNodeInput({ protocol: 'trojan', server: 'a.example', port: 443, password: 'p', fingerprint: 'chrome', alpn: ['h2'] });

  rejects({ protocol: 'ss', server: 'a.example', port: 8388, cipher: 'aes-128-gcm', password: 'p', uuid: 'x' }, /unsupported_proxy_field_uuid/);
  rejects({ protocol: 'vmess', server: 'a.example', port: 443, uuid: 'u', alterId: -1 }, /invalid_proxy_field_alterId/);
  rejects({ protocol: 'vmess', server: 'a.example', port: 443, uuid: 'u', network: 'kcp' }, /unsupported_proxy_transport_kcp/);
  rejects({ protocol: 'trojan', server: 'a.example', port: 443 }, /missing_required_proxy_field_password/);
  rejects({ protocol: 'vless', server: 'a.example', port: 443, uuid: 'u', security: 'xtls' }, /unsupported_proxy_security_xtls/);
  rejects({ protocol: 'vless', server: 'a.example', port: 443, uuid: 'u', security: 'reality' }, /missing_required_proxy_field_publicKey/);
  rejects({ protocol: 'hysteria2', server: 'a.example', port: 443, password: 'p', upMbps: 0 }, /invalid_proxy_field_upMbps/);
});

test('field errors keep the generic codes callers already match on', () => {
  try {
    validateProxyNodeInput({ protocol: 'vmess', server: 'a.example', port: 443, uuid: 'u', tls: 'yes' });
    assert.fail('expected a validation error');
  } catch (error) {
    assert.equal(error.code, 'invalid_proxy_field');
    assert.equal(error.message, 'invalid_proxy_field_tls');
  }
  try {
    validateProxyNodeInput({ protocol: 'vless', server: 'a.example', port: 443 });
    assert.fail('expected a validation error');
  } catch (error) {
    assert.equal(error.code, 'missing_required_proxy_field_uuid');
  }
});

test('connection keys follow the declared connection fields, not metadata', () => {
  const base = { protocol: 'trojan', server: 'a.example', port: 443, password: 'p', sni: 'one.example' };
  assert.equal(
    buildProxyNodeConnectionKey({ ...base, name: 'first' }),
    buildProxyNodeConnectionKey({ ...base, name: 'renamed', tags: ['x'] })
  );
  assert.notEqual(
    buildProxyNodeConnectionKey(base),
    buildProxyNodeConnectionKey({ ...base, sni: 'two.example' })
  );
});
