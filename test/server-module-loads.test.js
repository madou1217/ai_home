'use strict';

// server.js 是 Node 宿主的入口模块：语法错误或顶层 ReferenceError 会让
// `aih server restart` 失败，而旧进程仍在监听 9527，表现为「重启没生效」。
// 这里要求模块能被加载（不启动监听），把这类错误提前到测试阶段。

const test = require('node:test');
const assert = require('node:assert/strict');

test('lib/server/server.js 可加载且导出启动函数', () => {
  const server = require('../lib/server/server');
  assert.equal(typeof server, 'object');
  assert.ok(Object.keys(server).length > 0);
});
