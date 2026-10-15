'use strict';

// Go 能承接推理上游的 Provider 集合：与 Go 源码的一致性 + 交还判定的兜底行为。
//
// 为什么值得一个专门的守卫：Go 侧只有三个上游适配器（codex / claude / agy），其余 Provider
// 的请求划给 Go 就没有 Node 回落、只会失败。今天这层保护是**偶然的** —— Go 的 /v1/models
// 恰好只由这三个适配器的 catalog source 组成，所以别的 Provider 的模型不在集合里，命中
// model_not_routable 才交还 Node。目录来源一变，保护就静默消失，表现为「部分模型突然 503」。
//
// 本文件守三件事：
//   ① 集合与 Go 源码一致（core/inference/protocol.go 的 ProviderID 常量）；
//   ② 家族四支必须留在「Go 服务不了」这一侧（若 Go 实现了家族上游，这里会失败并提醒把
//      x-aih-degradations 降级头一起移植）；
//   ③ 交还判定真的按 Provider 兜住：钉选看被钉选账号，未钉选看整池，形状未知保守交还。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { GO_INFERENCE_PROVIDERS, goServesInference } = require('../lib/server/go-core-servable-providers');
const { explainGoRouteDeferral } = require('../lib/server/go-core-route-deferral');
const { FAMILY_PROVIDERS } = require('../lib/runtime/codebuddy-family-layouts');

const ROOT = path.join(__dirname, '..');
const LIVE = 'acct_0123456789abcdef0123';
const DOWN = 'acct_aaaaaaaaaaaaaaaaaaaa';
const accountStateIndex = {
  getAccountState: (ref) => ({ [LIVE]: { status: 'up' }, [DOWN]: { status: 'down' } }[ref] || null)
};
const INFERENCE_ENTRY = 'gateway.openai.chat_completions';
const routable = (...ids) => () => new Set(ids);

test('可服务集合与 Go 源码的 ProviderID 常量一致', () => {
  const source = fs.readFileSync(path.join(ROOT, 'core', 'inference', 'protocol.go'), 'utf8');
  const ids = [...source.matchAll(/^\s*Provider[A-Za-z]*\s+ProviderID\s*=\s*"([^"]+)"/gm)]
    .map((match) => match[1])
    .sort();
  assert.ok(ids.length > 0, '必须能从 core/inference/protocol.go 解析出 ProviderID 常量');
  assert.deepEqual(
    [...GO_INFERENCE_PROVIDERS].sort(),
    ids,
    'Node 的可服务集合与 Go 的 ProviderID 常量不一致：Go 新增 Provider 时必须补上游适配器并'
    + '同步本集合，否则该 Provider 的请求划给 Go 会失败（划转后没有 Node 回落）'
  );
});

test('家族四支不在 Go 可服务集合内（Go 侧没有家族上游适配器）', () => {
  for (const provider of FAMILY_PROVIDERS) {
    assert.equal(goServesInference(provider), false, `${provider} 不应出现在 Go 可服务集合里`);
  }
});

// 精确复现被识别的风险场景：**即使 Go 的模型目录里有这个模型**（routable 命中），只要被钉选
// 账号的 Provider 在 Go 侧没有上游适配器，也必须交还 Node —— 这条正是「偶然保护」换成
// 「显式能力判定」的意义。
test('钉选到 Go 服务不了的 Provider 时交还 Node（即使模型在 Go 目录里）', () => {
  const familyState = { accounts: { codebuddy: [{ accountRef: LIVE }] } };
  assert.deepEqual(
    explainGoRouteDeferral({
      entryId: INFERENCE_ENTRY,
      pinnedAccountRef: LIVE,
      model: 'hy4-preview',
      state: familyState,
      accountStateIndex,
      goRoutableModelIds: routable('hy4-preview')
    }),
    { defer: true, reason: 'provider_not_go_servable' }
  );
  // 可服务的 Provider 照常转发（不因为这条规则被误伤）。
  assert.deepEqual(
    explainGoRouteDeferral({
      entryId: INFERENCE_ENTRY,
      pinnedAccountRef: LIVE,
      model: 'gpt-5-codex',
      state: { accounts: { codex: [{ accountRef: LIVE }] } },
      accountStateIndex,
      goRoutableModelIds: routable('gpt-5-codex')
    }),
    { defer: false, reason: '' }
  );
});

test('池里存在 Go 服务不了的 Provider 时未钉选请求整体交还 Node', () => {
  assert.deepEqual(
    explainGoRouteDeferral({
      entryId: INFERENCE_ENTRY,
      model: 'gpt-5-codex',
      state: { accounts: { codex: [{ accountRef: LIVE }], workbuddy: [{ accountRef: DOWN }] } },
      goRoutableModelIds: routable('gpt-5-codex')
    }),
    { defer: true, reason: 'pool_has_non_go_servable_provider' }
  );
  // 只含可服务 Provider 的池不受影响。
  assert.deepEqual(
    explainGoRouteDeferral({
      entryId: INFERENCE_ENTRY,
      model: 'gpt-5-codex',
      state: { accounts: { codex: [{ accountRef: LIVE }], agy: [{ accountRef: DOWN }] } },
      goRoutableModelIds: routable('gpt-5-codex')
    }),
    { defer: false, reason: '' }
  );
});

test('池形状未知时保守交还 Node，空池与非推理条目不受影响', () => {
  assert.deepEqual(
    explainGoRouteDeferral({ entryId: INFERENCE_ENTRY, state: null }),
    { defer: true, reason: 'pool_has_non_go_servable_provider' }
  );
  assert.deepEqual(
    explainGoRouteDeferral({ entryId: INFERENCE_ENTRY, state: { accounts: [] } }),
    { defer: true, reason: 'pool_has_non_go_servable_provider' }
  );
  // 形状已知且没有任何账号：不算「有服务不了的 Provider」。
  assert.deepEqual(
    explainGoRouteDeferral({
      entryId: INFERENCE_ENTRY,
      model: 'm',
      state: { accounts: { codex: [] } },
      goRoutableModelIds: routable('m')
    }),
    { defer: false, reason: '' }
  );
  // 非推理条目完全不看这条规则。
  assert.deepEqual(
    explainGoRouteDeferral({ entryId: 'gateway.props', state: null }),
    { defer: false, reason: '' }
  );
});
