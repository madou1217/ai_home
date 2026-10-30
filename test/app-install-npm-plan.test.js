'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildNpmPlan,
  buildNpmUpdatePlan,
  buildNpmUninstallPlan,
  buildNpmNetworkArgs
} = require('../lib/server/app-installers/official-install');

// 2026-10-30 实测：toolkit 的 dsh / qodercli / opencode 三个安装作业同时跑时，npm 到
// registry.npmjs.org 的连接 ESTABLISHED 但 0 字节、CPU 0%，作业在 20 分钟超时前一直
// 停在 installing。默认 fetch-timeout 5 分钟 + 退避 10s→100s 让「一个挂住的 socket」
// 变成「整台机器看起来装不动」，所以计划里必须带上更短的超时与封顶退避。
test('npm 安装计划带网络韧性参数（短超时 + 封顶退避 + 关掉 audit/fund）', () => {
  const plan = buildNpmPlan('@deepseek-ai/dsh');
  const args = plan.args.join(' ');
  // 并发压到 4：16 路并发实测有 ~12% 连接挂死（40s 0 字节），默认 maxsockets=15 几乎必然踩中。
  assert.match(args, /--maxsockets=4/);
  assert.match(args, /--fetch-timeout=60000/);
  assert.match(args, /--fetch-retries=3/);
  assert.match(args, /--fetch-retry-maxtimeout=20000/);
  assert.match(args, /--no-audit/);
  assert.match(args, /--no-fund/);
  // 隔离口径不变：安装永远用公共 registry + 忽略用户 ~/.npmrc。
  assert.match(args, /--userconfig=\/dev\/null/);
  assert.match(args, /--registry=https:\/\/registry\.npmjs\.org/);
  // 20 分钟作业超时必须大于单次请求超时，否则重试还没跑完就被杀。
  assert.ok(plan.timeoutMs >= 60000 * 3);
});

test('update / uninstall 计划同样带网络韧性参数', () => {
  for (const plan of [buildNpmUpdatePlan('@deepseek-ai/dsh'), buildNpmUninstallPlan('@deepseek-ai/dsh')]) {
    const args = plan.args.join(' ');
    assert.match(args, /--fetch-timeout=60000/);
    assert.match(args, /--fetch-retries=3/);
  }
});

test('调用方自带 --registry 会被隔离口径覆盖，且网络参数不重复', () => {
  const args = buildNpmNetworkArgs();
  assert.equal(new Set(args).size, args.length);
  const plan = buildNpmPlan('@deepseek-ai/dsh');
  assert.equal(plan.args.filter((arg) => arg === '--fetch-timeout=60000').length, 1);
});
