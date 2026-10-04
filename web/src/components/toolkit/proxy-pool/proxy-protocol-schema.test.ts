import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildProxyNodePayload,
  FALLBACK_PROXY_PROTOCOLS,
  groupProtocolFields,
  protocolFilterOptions
} from './proxy-protocol-schema.ts';

test('节点提交只保留通用字段与协议插件声明的字段', () => {
  const payload = buildProxyNodePayload(FALLBACK_PROXY_PROTOCOLS, { uuid: 'old', name: 'n' }, {
    protocol: 'trojan',
    server: 'a.example.com',
    port: 443,
    password: 'pw',
    cipher: 'aes-256-gcm'
  });
  assert.deepEqual(payload, { name: 'n', protocol: 'trojan', server: 'a.example.com', port: 443, password: 'pw' });
});

test('https 节点归入 http 插件，筛选项来自插件清单', () => {
  const payload = buildProxyNodePayload(FALLBACK_PROXY_PROTOCOLS, {}, { protocol: 'https', server: 'h', port: 1, sni: 's' });
  assert.equal(payload.sni, 's');
  assert.deepEqual(protocolFilterOptions(FALLBACK_PROXY_PROTOCOLS).map((option) => option.value)[0], 'all');
});

test('同 row 的相邻字段并排分组', () => {
  const vmess = FALLBACK_PROXY_PROTOCOLS.find((plugin) => plugin.id === 'vmess');
  assert.deepEqual(groupProtocolFields(vmess?.editor.fields || []).map((group) => group.map((field) => field.key)), [
    ['uuid'], ['network', 'tls'], ['sni', 'path']
  ]);
});
