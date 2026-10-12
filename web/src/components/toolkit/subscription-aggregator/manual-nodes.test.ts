import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compactNode,
  manualNodeSaveInput,
  parseManualContent,
  prefillFromProbe,
  removeManualNode,
  serializeManualNodes,
  upsertManualNode
} from './manual-nodes.ts';
import type { AggregatorProbePort } from './types.ts';

const SOCKS = { protocol: 'socks5', name: 's', server: 's.example', port: 1080 };
const TROJAN = { protocol: 'trojan', name: 't', server: 't.example', port: 443, password: 'p' };

test('manual nodes round-trip through the neutral JSON content', () => {
  const content = serializeManualNodes([SOCKS, TROJAN]);
  assert.deepEqual(parseManualContent(content), [SOCKS, TROJAN]);
  assert.equal(parseManualContent('trojan://x'), null, '不是中立 JSON 的本地源不能按表格编辑');
  assert.equal(parseManualContent('{"version":2,"nodes":[]}'), null);
  assert.deepEqual(upsertManualNode([SOCKS], TROJAN), [SOCKS, TROJAN]);
  assert.deepEqual(upsertManualNode([SOCKS, TROJAN], { ...SOCKS, name: 's2' }, 0)[0].name, 's2');
  assert.deepEqual(removeManualNode([SOCKS, TROJAN], 0), [TROJAN]);
  assert.deepEqual(compactNode({ ...SOCKS, username: '', alpn: [], sni: undefined, tls: false }), { ...SOCKS, tls: false });
});

test('probe results prefill the form, with REALITY when the certificate belongs to another site', () => {
  const tlsPort = (sniMatch: boolean | null, names: string[]): AggregatorProbePort => ({
    port: 443,
    open: true,
    candidates: ['vless', 'trojan'],
    note: '',
    tls: { alpn: 'h2', names, issuer: '', selfSigned: false, validTo: '', sniMatch, proxyStatus: 0 }
  });
  assert.deepEqual(prefillFromProbe({ host: 'node.example.com' }, tlsPort(false, ['www.microsoft.com'])), {
    protocol: 'vless', server: 'node.example.com', port: 443, name: 'node.example.com:443', tls: true, sni: 'www.microsoft.com', security: 'reality', alpn: ['h2']
  });
  assert.deepEqual(prefillFromProbe({ host: 'node.example.com' }, tlsPort(true, ['*.example.com']), 'trojan'), {
    protocol: 'trojan', server: 'node.example.com', port: 443, name: 'node.example.com:443', tls: true, sni: 'node.example.com', alpn: ['h2']
  });
  assert.deepEqual(prefillFromProbe({ host: '1.2.3.4' }, { port: 1080, open: true, candidates: ['socks5'], note: '', socks5: 'userpass' }), {
    protocol: 'socks5', server: '1.2.3.4', port: 1080, name: '1.2.3.4:1080'
  });
});

test('manually added nodes go to the first manual source, or a new one', () => {
  const remote = { id: 'sub_r', name: '机场', kind: 'remote' as const, content: undefined };
  const pasted = { id: 'sub_p', name: '粘贴', kind: 'local' as const, content: 'trojan://x' };
  const manual = { id: 'sub_m', name: '我的手动节点', kind: 'local' as const, content: serializeManualNodes([SOCKS]) };
  assert.deepEqual(manualNodeSaveInput([remote, pasted], TROJAN), { name: '手动节点', kind: 'local', content: serializeManualNodes([TROJAN]) });
  assert.deepEqual(manualNodeSaveInput([remote, pasted, manual], TROJAN), {
    id: 'sub_m', name: '我的手动节点', kind: 'local', content: serializeManualNodes([SOCKS, TROJAN])
  });
});
