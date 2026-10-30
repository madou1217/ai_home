'use strict';

// 回归守卫（2026-10-30 真机）：WebUI 的「从本机登录态导入」对 codebuddy 回
// `auth_source_impl_missing`。原因是 codebuddy 家族登记的是**扫描来源**
// （handler: host-account-scan），它本来就没有「单账号导入」实现——语义是
// 「本机登录态整批入库」，与 `aih codebuddy detect` 同一条链路。
// 这里钉住来源的形状，防止哪天描述符被改成「看起来能单账号导入」而让那条错误路径复活。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveAuthSources } = require('../lib/account/auth-sources');

function withTempHome(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-hostscan-'));
  try {
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('codebuddy 的认证来源是扫描来源，没有单账号导入实现', () => {
  withTempHome((aiHomeDir) => {
    const resolved = resolveAuthSources('codebuddy', {
      fs,
      aiHomeDir,
      hostCapabilitiesOptions: { hostHomeDir: os.homedir() }
    });
    const source = (resolved.sources || []).find((item) => item.id === 'codebuddy-host-scan');
    assert.ok(source, '必须登记 codebuddy-host-scan');
    assert.equal(source.handler, 'host-account-scan');
    // 解析结果里实现位是 null（不是函数）——这正是路由必须特判 handler 的原因。
    assert.notEqual(typeof source.implementation, 'function');
    assert.equal(source.directImport, false, '整批扫描入库，不能当单账号直接导入');
  });
});
