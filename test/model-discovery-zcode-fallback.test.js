'use strict';

// 回归守卫：zcode 模型发现兜底分支删除（docs/plans/2026-11-06-http-utils-provider-fallback.md 第 2 步）。
//
// 背景：fetchModelsForAccount 尾部曾有一段 `if (provider === 'zcode') { … }` 的硬编码兜底。
// 描述符链已经声明了 zcode-plan-models / zcode-generic-models 两条策略，这段兜底只会
// 把同一份探测再跑一次。本测试钉住删除后必须仍然成立的语义：
//
//   1. 登录态拿不到 zcodeJwtToken → 仍抛 zcode_jwt_missing_relogin（terminal），
//      不回退 paas 探测、不落到通用探测；
//   2. 登录态目录可用 → 原样返回，且探测只发生一次（没有第二次重复调用）；
//   3. API Key 账号 → 只走通用 /models 探测，不碰 plan 目录；
//   4. 登录态「目录为空」→ 兜底已不存在，落到通用探测（这是删除带来的唯一行为变化，
//      见 docs/agent-reports/dev-4-zcode.md；修法是给策略加 emptyAuthoritative，属于描述符侧改动）。

const test = require('node:test');
const assert = require('node:assert/strict');

const zcodeModule = require('../lib/server/http-utils-zcode');
const probeModule = require('../lib/server/model-discovery/generic-models-probe');

const calls = [];
let planImpl = async () => null;
let probeImpl = async () => { throw new Error('probe_should_not_run'); };

// http-utils 在 load 时解构这些导出，所以必须在 require 之前替换。
zcodeModule.fetchZcodePlanBalanceModels = async (...args) => {
  calls.push('zcode-plan');
  return planImpl(...args);
};
probeModule.fetchGenericModelsProbe = async (...args) => {
  calls.push('generic');
  return probeImpl(...args);
};

const { fetchModelsForAccount } = require('../lib/server/http-utils');

function reset() {
  calls.length = 0;
  planImpl = async () => null;
  probeImpl = async () => { throw new Error('probe_should_not_run'); };
}

const EGRESS = async () => ({ ok: true, options: {} });
const CLI_NULL = async () => null;

function callZcode(account, extraOptions = {}) {
  return fetchModelsForAccount({
    resolveAccountEgressRequestOptions: EGRESS,
    discoverNativeCliModels: CLI_NULL,
    ...extraOptions
  }, { provider: 'zcode', ...account }, 1000);
}

test('登录态没有 zcodeJwtToken：仍抛 zcode_jwt_missing_relogin（terminal 语义不变）', async () => {
  reset();
  const error = await callZcode({ accessToken: 'expired-access-token' }).then(
    () => null,
    (err) => err
  );
  assert.ok(error, '必须抛错，不能返回空目录');
  assert.equal(error.code, 'zcode_jwt_missing_relogin');
  assert.equal(error.reloginRequired, true);
  // 兜底已删：plan 目录只由策略链探测一次。
  assert.deepEqual(calls, ['zcode-plan'], '不回退 paas、不重复探测、不落通用探测');
});

test('登录态目录可用：原样返回，且只探测一次', async () => {
  reset();
  planImpl = async () => ['glm-5.3', 'zcode-v3-start-plan-1024'];
  const models = await callZcode({ zcodeJwtToken: 'jwt-ok' });
  assert.deepEqual(models, ['glm-5.3', 'zcode-v3-start-plan-1024']);
  assert.deepEqual(calls, ['zcode-plan'], '没有第二次重复探测');
});

test('登录态目录为空：不再返回 []，落到通用探测（删除带来的唯一行为变化）', async () => {
  reset();
  planImpl = async () => [];            // balance 与 preview 都没给出模型
  probeImpl = async () => { throw new Error('generic_probe_reached'); };
  const error = await callZcode({ zcodeJwtToken: 'jwt-empty' }).then(
    () => null,
    (err) => err
  );
  assert.ok(error, '删除后该场景不再静默返回空目录');
  assert.match(String(error.message), /generic_probe_reached/);
  assert.deepEqual(calls, ['zcode-plan', 'generic'], 'plan 只探一次，随后落通用探测');
});

test('API Key 账号：只走通用 /models，不碰 plan 目录', async () => {
  reset();
  probeImpl = async () => ['zcode-glm-5.3'];
  const models = await callZcode({ apiKeyMode: true, authType: 'api-key', accessToken: 'sk-xxx' });
  assert.deepEqual(models, ['zcode-glm-5.3']);
  assert.equal(calls.includes('zcode-plan'), false, 'api-key 账号不得触碰 plan 目录');
  // 通用探测当前会被调用两次（链上一次 + 尾部一次）：generic-models-probe handler 返回裸数组，
  // 而门面按 { models } 读取，链上那次必然记成 empty_catalog。这是本次范围外的既有缺陷，
  // 见 docs/agent-reports/dev-4-zcode.md「相邻发现」。
  assert.ok(calls.every((name) => name === 'generic'));
});
