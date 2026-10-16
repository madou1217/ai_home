import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EDGE_NGINX_MODES,
  EDGE_PROVIDER_META,
  describeApplyResult,
  describeEdgeError
} from './edge-proxy-presentation.ts';

test('describeEdgeError 把服务端错误码翻成人话与下一步', () => {
  assert.match(describeEdgeError('edge_provider_not_installed'), /没装/);
  assert.match(describeEdgeError('edge_config_not_writable', 'linux'), /sudo/);
  assert.match(describeEdgeError('edge_config_not_writable', 'win32'), /管理员/);
  assert.match(describeEdgeError('edge_config_rejected'), /回滚/);
  assert.equal(describeEdgeError('some_unknown_code'), 'some_unknown_code');
});

test('三种 nginx 形态只有一份顺序事实源', () => {
  assert.deepEqual(EDGE_NGINX_MODES.map((mode) => mode.value), ['split', 'passthrough', 'http-only']);
  assert.ok(EDGE_NGINX_MODES.every((mode) => mode.detail.length > 0));
});

test('每个软件的能力边界写在展示层里，界面不自己判断', () => {
  assert.match(EDGE_PROVIDER_META.caddy.capability, /SOCKS5 上不来/);
  assert.match(EDGE_PROVIDER_META.nginx.role, /SOCKS5/);
  assert.match(EDGE_PROVIDER_META.frp.role, /VPS/);
});

test('describeApplyResult 成功时给出写了哪些文件、怎么重载的', () => {
  const line = describeApplyResult({
    ok: true,
    summary: 'nginx：443/TCP+UDP 纯透传',
    files: [
      { path: '/etc/nginx/aih-edge-stream.conf', existed: false },
      { path: '/etc/nginx/nginx.conf', existed: true, backupPath: '/etc/nginx/nginx.conf.bak-1' }
    ],
    reloaded: true,
    reloadedVia: 'nginx-s'
  });
  assert.equal(line.tone, 'success');
  assert.match(line.text, /已重载（nginx-s）/);
  assert.match(line.detail, /新建 \/etc\/nginx\/aih-edge-stream\.conf/);
  assert.match(line.detail, /备份 \/etc\/nginx\/nginx\.conf\.bak-1/);
});

test('describeApplyResult 失败时透出内核原话而不是通用文案', () => {
  const line = describeApplyResult({ ok: false, error: 'edge_config_rejected', detail: 'unknown directive "stream"' });
  assert.equal(line.tone, 'error');
  assert.match(line.text, /回滚/);
  assert.match(line.detail, /unknown directive/);
});

test('describeApplyResult 不谎报重载', () => {
  const line = describeApplyResult({ ok: true, summary: 'Caddy：已写入', reloaded: false, hint: '请手动重启 caddy' });
  assert.match(line.text, /未重载：请手动重启 caddy/);
});
