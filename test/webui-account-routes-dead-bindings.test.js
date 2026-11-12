'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// 账号写路由的拆分脚本会把原文件的整段 require 复制到每个子模块，路由逻辑搬走之后
// 绑定就再也没人用了。这些死绑定不会报错，只会让「这行依赖到底服务哪个分支」越来越
// 难判断——逐个路由核对 Go 归属时，它们是最大的噪音来源。
//
// 守卫：账号写路由相关模块里，每个 require 绑定都必须在文件内至少出现两次
// （声明 + 使用）。新增死导入时这里直接红，而不是等下一次迁移盘点再人工发现。
const ROUTE_MODULES = Object.freeze([
  'lib/server/webui-account-routes.js',
  'lib/server/webui-account-routes-utils.js',
  'lib/server/webui-account-routes-desktop.js',
  'lib/server/webui-account-routes-refresh.js',
  'lib/server/webui-account-routes-import.js',
  'lib/server/webui-account-routes-state.js',
  'lib/server/webui-account-routes-delete.js'
]);

const REPO_ROOT = path.join(__dirname, '..');

/** 解析文件里全部 const {…} = require('…') / const X = require('…') 绑定。 */
function readRequireBindings(source) {
  const bindings = [];
  const statement = /^const (\{[\s\S]*?\}|[A-Za-z0-9_$]+) = require\(([^)]*)\);/gm;
  let match;
  while ((match = statement.exec(source))) {
    const target = match[1];
    const names = target.startsWith('{')
      ? target.slice(1, -1)
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean)
      : [target];
    for (const name of names) bindings.push({ name, from: match[2] });
  }
  return bindings;
}

function countIdentifier(source, name) {
  return (source.match(new RegExp('\\b' + name + '\\b', 'g')) || []).length;
}

test('账号写路由模块没有声明后从不使用的 require 绑定', () => {
  const dead = [];
  for (const relative of ROUTE_MODULES) {
    const source = fs.readFileSync(path.join(REPO_ROOT, relative), 'utf8');
    for (const binding of readRequireBindings(source)) {
      if (countIdentifier(source, binding.name) <= 1) {
        dead.push(`${relative}: ${binding.name} (${binding.from})`);
      }
    }
  }
  assert.deepEqual(dead, [], `发现只声明未使用的 require 绑定：\n${dead.join('\n')}`);
});

test('删除路由的原生会话守卫只保留占位者探测这一条实现路径', () => {
  const deleteModule = fs.readFileSync(
    path.join(REPO_ROOT, 'lib/server/webui-account-routes-delete.js'),
    'utf8'
  );
  // 旧的 assertNoActiveNativeRunBeforeDelete 是「先判 Go 能不能删、再判会话占用」时代的
  // 硬拦截；现在删除统一走 detectDeletionBlockers 的 native_session 占用者（带 force
  // 释放语义），同一个事实不允许有两套判定。回归时如果它被重新引入，这里会红。
  assert.equal(deleteModule.includes('assertNoActiveNativeRunBeforeDelete'), false);
  const routes = fs.readFileSync(
    path.join(REPO_ROOT, 'lib/server/webui-account-routes.js'),
    'utf8'
  );
  assert.equal(routes.includes('assertNoActiveNativeRunBeforeDelete'), false);
});
