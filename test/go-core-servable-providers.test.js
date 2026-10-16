'use strict';

// Go 能承接推理上游的 Provider/入口表：与 Go 源码的一致性 + 交还判定的兜底行为。
//
// 为什么值得一个专门的守卫：Go 侧只有两条推理通道 —— canonical（codex / claude / agy
// 三个上游适配器）与家族透传（codebuddy 四支，只挂在 chat completions 入口）。其余
// Provider 的请求划给 Go 就没有 Node 回落、只会失败。今天这层保护是**偶然的** —— Go 的
// /v1/models 恰好只由 canonical 适配器的 catalog source 组成，所以别的 Provider 的模型
// 不在集合里，命中 model_not_routable 才交还 Node。目录来源一变，保护就静默消失，表现为
// 「部分模型突然 503」。
//
// 本文件守五件事：
//   ① canonical 集合与 Go 源码一致（core/inference/protocol.go 的 ProviderID 常量）；
//   ② 家族透传集合与 Go 的 FamilyProviders、Node 的 FAMILY_PROVIDERS 三方一致，且 Go
//      确实把家族 Handler 挂在 chat completions 入口上（挂载消失 = Node 会转发给一个
//      不存在的通道）；
//   ③ 家族只在透传挂载的入口（chat completions）上算「Go 服务得了」，别的入口照旧交还；
//   ④ 钉选判定：透传入口上家族按 Node 自己的硬证据收窄（目录已知且不含该模型 = 交还），
//      弱证据放行；该入口上真正服务不了的 Provider 照旧交还；
//   ⑤ 池级判定带入口：家族在透传入口不再单独触发池级交还，其它入口/其它 Provider 照旧；
//   ⑥ 池门的模型级收窄：承载者（索引里真有该模型账号的 Provider，与 Node 的绑定分同源）
//      全为透传通道的模型才转发，混合/无绑定照旧交还 Node。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  GO_CANONICAL_INFERENCE_PROVIDERS,
  GO_RELAY_INFERENCE_PROVIDERS,
  GO_RELAY_INFERENCE_ENTRIES,
  GO_INFERENCE_CHANNEL_CANONICAL,
  GO_INFERENCE_CHANNEL_RELAY,
  goInferenceChannel,
  goServesInference
} = require('../lib/server/go-core-servable-providers');
const { explainGoRouteDeferral } = require('../lib/server/go-core-route-deferral');
const { FAMILY_PROVIDERS } = require('../lib/runtime/codebuddy-family-layouts');

const ROOT = path.join(__dirname, '..');
const LIVE = 'acct_0123456789abcdef0123';
const DOWN = 'acct_aaaaaaaaaaaaaaaaaaaa';
const accountStateIndex = {
  getAccountState: (ref) => ({ [LIVE]: { status: 'up' }, [DOWN]: { status: 'down' } }[ref] || null)
};
const INFERENCE_ENTRY = 'gateway.openai.chat_completions';
const MESSAGES_ENTRY = 'gateway.anthropic.messages';
const routable = (...ids) => () => new Set(ids);

// 与生产 index 同形（model-account-index）：承载者判定只读这份正向索引
// （与 getModelBindingScore 同源）；entries 为 [accountRef, provider, models[]]。
const indexFor = (entries) => {
  const modelToAccounts = new Map();
  const accountToModels = new Map();
  const accountByRef = new Map();
  for (const [accountRef, provider, models] of entries) {
    accountByRef.set(accountRef, { accountRef, provider });
    accountToModels.set(accountRef, new Set(models));
    for (const model of models) {
      const refs = modelToAccounts.get(model) || [];
      if (!refs.includes(accountRef)) refs.push(accountRef);
      modelToAccounts.set(model, refs);
    }
  }
  return { builtAt: 1, modelToAccounts, accountToModels, accountByRef };
};

test('canonical 集合与 Go 源码的 ProviderID 常量一致', () => {
  const source = fs.readFileSync(path.join(ROOT, 'core', 'inference', 'protocol.go'), 'utf8');
  const ids = [...source.matchAll(/^\s*Provider[A-Za-z]*\s+ProviderID\s*=\s*"([^"]+)"/gm)]
    .map((match) => match[1])
    .sort();
  assert.ok(ids.length > 0, '必须能从 core/inference/protocol.go 解析出 ProviderID 常量');
  assert.deepEqual(
    [...GO_CANONICAL_INFERENCE_PROVIDERS].sort(),
    ids,
    'Node 的 canonical 集合与 Go 的 ProviderID 常量不一致：Go 新增 Provider 时必须补上游适配器并'
    + '同步本集合，否则该 Provider 的请求划给 Go 会失败（划转后没有 Node 回落）'
  );
});

test('家族透传集合与 Go 的 FamilyProviders 一致，且确实挂在 chat completions 入口', () => {
  // ① 三方集合一致：Node 能力表 == Go 透传包 == Node 家族布局表。
  const familySource = fs.readFileSync(
    path.join(ROOT, 'internal', 'transport', 'http', 'codebuddyfamilyrelay', 'family_provider.go'),
    'utf8'
  );
  const goFamily = [...familySource.matchAll(/var FamilyProviders = \[\]string\{([^}]*)\}/g)]
    .flatMap((match) => [...match[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]));
  assert.ok(goFamily.length > 0, '必须能从 Go 源码解析出 FamilyProviders');
  assert.deepEqual(
    [...GO_RELAY_INFERENCE_PROVIDERS].sort(),
    [...goFamily].sort(),
    'Node 的透传集合与 Go 的 FamilyProviders 不一致'
  );
  assert.deepEqual(
    [...GO_RELAY_INFERENCE_PROVIDERS].sort(),
    [...FAMILY_PROVIDERS].sort(),
    'Node 的透传集合与 Node 的家族布局表 FAMILY_PROVIDERS 不一致'
  );
  // ② Go 的挂载：chat completions 入口必须过家族 Handler（nil 时才回退 Canonical）。
  const router = fs.readFileSync(
    path.join(ROOT, 'internal', 'host', 'aihserver', 'router.go'),
    'utf8'
  );
  assert.match(
    router,
    /chatCompletions\s*:=\s*handlers\.familyRelay/,
    'Go router 必须把 chat completions 入口接到家族透传 Handler；拆掉挂载时本守卫与'
    + ' Node 的透传能力表必须一起改，否则 Node 会把请求转发给一个不存在的通道'
  );
  assert.match(
    router,
    /chatCompletions\s*=\s*handlers\.inference/,
    '家族 Handler 未装配（含 router 单测）时必须回退 Canonical，不能把入口挂空'
  );
  const mountLine = router
    .split('\n')
    .find((line) => line.includes('openaichatcompletionsapi.Path'));
  assert.ok(mountLine && mountLine.includes('chatCompletions'), 'chat completions 挂载行必须使用家族入口变量');
  // ③ 入口表：目前透传只挂这一个入口。
  assert.deepEqual([...GO_RELAY_INFERENCE_ENTRIES], ['gateway.openai.chat_completions']);
});

test('家族只在透传挂载的入口上算 Go 服务得了，别的入口照旧交还', () => {
  for (const provider of FAMILY_PROVIDERS) {
    assert.equal(
      goServesInference(provider),
      false,
      `${provider} 缺省入口（entryId 未知）时必须按「服务不了」保守处理`
    );
    assert.equal(
      goInferenceChannel(provider, INFERENCE_ENTRY),
      GO_INFERENCE_CHANNEL_RELAY,
      `${provider} 在 chat completions 上必须走透传通道`
    );
    assert.equal(goServesInference(provider, INFERENCE_ENTRY), true);
    assert.equal(
      goServesInference(provider, MESSAGES_ENTRY),
      false,
      `${provider} 在未挂载透传的入口（anthropic messages）上仍必须交还`
    );
  }
  for (const provider of GO_CANONICAL_INFERENCE_PROVIDERS) {
    assert.equal(goInferenceChannel(provider, INFERENCE_ENTRY), GO_INFERENCE_CHANNEL_CANONICAL);
    assert.equal(goServesInference(provider), true, 'canonical 通道的判定与入口无关');
  }
});

// 精确复现被识别的风险场景：**即使 Go 的模型目录里有这个模型**（routable 命中），只要被钉选
// 账号的 Provider 在该入口上没有 Go 通道，也必须交还 Node —— 这条正是「偶然保护」换成
// 「显式能力判定」的意义。
test('钉选到该入口上 Go 服务不了的 Provider 时交还 Node（即使模型在 Go 目录里）', () => {
  const openCodeState = { accounts: { opencode: [{ accountRef: LIVE }] } };
  assert.deepEqual(
    explainGoRouteDeferral({
      entryId: INFERENCE_ENTRY,
      pinnedAccountRef: LIVE,
      model: 'hy4-preview',
      state: openCodeState,
      accountStateIndex,
      goRoutableModelIds: routable('hy4-preview')
    }),
    { defer: true, reason: 'provider_not_go_servable' }
  );
  // 家族在透传入口不再触发该规则：模型甚至不在 Go 的 canonical 目录里也照常转发
  // （透传按账号原生登录态直连官方端点，不看 Go 目录）。
  assert.deepEqual(
    explainGoRouteDeferral({
      entryId: INFERENCE_ENTRY,
      pinnedAccountRef: LIVE,
      model: 'hy4-preview',
      state: { accounts: { workbuddy: [{ accountRef: LIVE }] } },
      accountStateIndex,
      goRoutableModelIds: routable()
    }),
    { defer: false, reason: '' }
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

test('透传钉选的模型判定按 Node 的硬证据收窄（与 Node 钉选路径同口径）', () => {
  const pinnedState = (accountCatalog) => ({
    accounts: { workbuddy: [{ accountRef: LIVE }] },
    modelAccountIndex: {
      builtAt: accountCatalog ? 1 : 0,
      accountToModels: accountCatalog ? new Map([[LIVE, new Set(accountCatalog)]]) : new Map()
    }
  });
  // 目录已知且不含该模型：强否定证据 → 交还 Node（由 Node 渲染 no_available_account）。
  assert.deepEqual(
    explainGoRouteDeferral({
      entryId: INFERENCE_ENTRY,
      pinnedAccountRef: LIVE,
      model: 'hy4-preview',
      state: pinnedState(['hy3-legacy']),
      accountStateIndex
    }),
    { defer: true, reason: 'pinned_model_not_routable' }
  );
  // 目录已知且包含该模型：转发。
  assert.deepEqual(
    explainGoRouteDeferral({
      entryId: INFERENCE_ENTRY,
      pinnedAccountRef: LIVE,
      model: 'hy4-preview',
      state: pinnedState(['hy4-preview']),
      accountStateIndex
    }),
    { defer: false, reason: '' }
  );
  // 用户显式停用的 (账号, 模型) 是最强否定证据 → 交还。
  assert.deepEqual(
    explainGoRouteDeferral({
      entryId: INFERENCE_ENTRY,
      pinnedAccountRef: LIVE,
      model: 'hy4-preview',
      state: {
        ...pinnedState(['hy4-preview']),
        modelCatalogSettings: {
          accountModels: [{ id: 'hy4-preview', provider: 'workbuddy', accountRef: LIVE, enabled: false }]
        }
      },
      accountStateIndex
    }),
    { defer: true, reason: 'pinned_model_not_routable' }
  );
  // 非透传入口仍按 Go 的 canonical 目录判定（家族模型不在目录里 → 交还）。
  assert.deepEqual(
    explainGoRouteDeferral({
      entryId: MESSAGES_ENTRY,
      pinnedAccountRef: LIVE,
      model: 'hy4-preview',
      state: pinnedState(['hy4-preview']),
      accountStateIndex,
      goRoutableModelIds: routable()
    }),
    { defer: true, reason: 'pinned_model_not_routable' }
  );
});

test('池级判定带入口：家族只在透传入口豁免，其它 Provider/入口照旧整体交还', () => {
  // chat completions 上池里的家族账号已被 Go 透传覆盖，不再单独触发池级交还。
  assert.deepEqual(
    explainGoRouteDeferral({
      entryId: INFERENCE_ENTRY,
      model: 'gpt-5-codex',
      state: { accounts: { codex: [{ accountRef: LIVE }], workbuddy: [{ accountRef: DOWN }] } },
      goRoutableModelIds: routable('gpt-5-codex')
    }),
    { defer: false, reason: '' }
  );
  // 池里还有真正服务不了的 Provider（该入口上没有 Go 通道）且它是这个模型的承载者
  // （索引里有绑定）→ 照旧整体交还。
  assert.deepEqual(
    explainGoRouteDeferral({
      entryId: INFERENCE_ENTRY,
      model: 'gpt-5-codex',
      state: {
        accounts: { codex: [{ accountRef: LIVE }], gemini: [{ accountRef: DOWN }] },
        modelAccountIndex: indexFor([[DOWN, 'gemini', ['gpt-5-codex']]])
      },
      goRoutableModelIds: routable('gpt-5-codex')
    }),
    { defer: true, reason: 'pool_has_non_go_servable_provider' }
  );
  // 非透传入口（anthropic messages）上家族仍算服务不了 → 池级交还。
  assert.deepEqual(
    explainGoRouteDeferral({
      entryId: MESSAGES_ENTRY,
      model: 'claude-sonnet-4',
      state: {
        accounts: { claude: [{ accountRef: LIVE }], workbuddy: [{ accountRef: DOWN }] },
        modelAccountIndex: indexFor([[LIVE, 'claude', ['claude-sonnet-4']]])
      },
      goRoutableModelIds: routable('claude-sonnet-4')
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

test('池门模型级收窄：承载者全为透传通道才转发，混合/未知照旧交还', () => {
  const relayOnlyState = {
    accounts: { workbuddy: [{ accountRef: LIVE }], zcode: [{ accountRef: DOWN }] },
    modelAccountIndex: indexFor([[LIVE, 'workbuddy', ['hy4-preview']]])
  };
  // workbuddy 在索引里绑定这个模型 → 承载者；zcode 没有任何绑定（目录未知）→ 不是承载者。
  // 承载者全为透传通道（chat completions 挂载了家族 Handler）→ 转发 Go。
  assert.deepEqual(
    explainGoRouteDeferral({
      entryId: INFERENCE_ENTRY,
      model: 'hy4-preview',
      state: relayOnlyState,
      goRoutableModelIds: routable('hy4-preview')
    }),
    { defer: false, reason: '' }
  );
  // 池门之后的 Go 目录门照旧生效：Go 侧目录还没物化这个模型 → 交还（不是池门的原因）。
  assert.deepEqual(
    explainGoRouteDeferral({
      entryId: INFERENCE_ENTRY,
      model: 'hy4-preview',
      state: relayOnlyState,
      goRoutableModelIds: routable()
    }),
    { defer: true, reason: 'model_not_routable' }
  );
  // 别名门也仍在池门之后生效：命中未接受别名的请求即使承载者全为透传也交还 Node。
  assert.deepEqual(
    explainGoRouteDeferral({
      entryId: INFERENCE_ENTRY,
      model: 'hy4-preview',
      state: relayOnlyState,
      aliases: [{ id: 'alias-1', alias: 'hy4-*', enabled: true }],
      goRoutableModelIds: routable('hy4-preview')
    }),
    { defer: true, reason: 'model_alias' }
  );
  // 承载者混合：kimi 在索引里也绑定这个模型（真有该模型的账号）→ 没有 Go 通道 → 交还。
  assert.deepEqual(
    explainGoRouteDeferral({
      entryId: INFERENCE_ENTRY,
      model: 'hy4-preview',
      state: {
        accounts: { workbuddy: [{ accountRef: LIVE }], kimi: [{ accountRef: DOWN }] },
        modelAccountIndex: indexFor([
          [LIVE, 'workbuddy', ['hy4-preview']],
          [DOWN, 'kimi', ['hy4-preview']]
        ])
      },
      goRoutableModelIds: routable('hy4-preview')
    }),
    { defer: true, reason: 'pool_has_non_go_servable_provider' }
  );
  // 承载者为空：索引里没有任何账号绑定这个模型（目录全已知且都不含它）→ 交还 Node 裁定
  // （Node 会按自己的弱证据语义渲染 no_available_account 或走别名回落，不由 Go 提前合成）。
  assert.deepEqual(
    explainGoRouteDeferral({
      entryId: INFERENCE_ENTRY,
      model: 'hy4-preview',
      state: {
        accounts: { workbuddy: [{ accountRef: LIVE }], kimi: [{ accountRef: DOWN }] },
        modelAccountIndex: indexFor([
          [LIVE, 'workbuddy', ['hy3-legacy']],
          [DOWN, 'kimi', ['kimi-k3']]
        ])
      },
      goRoutableModelIds: routable('hy4-preview')
    }),
    { defer: true, reason: 'pool_model_carriers_unknown' }
  );
  // 索引未建（builtAt 未置位）：与 getModelBindingScore 同口径 —— 所有绑定都是 0，
  // Node 会落到「缓存 + 注册表」的回落选择，不在本判定的证据范围内 → 按未知交还。
  assert.deepEqual(
    explainGoRouteDeferral({
      entryId: INFERENCE_ENTRY,
      model: 'hy4-preview',
      state: {
        accounts: { workbuddy: [{ accountRef: LIVE }], kimi: [{ accountRef: DOWN }] },
        modelAccountIndex: { ...indexFor([[LIVE, 'workbuddy', ['hy4-preview']]]), builtAt: 0 }
      },
      goRoutableModelIds: routable('hy4-preview')
    }),
    { defer: true, reason: 'pool_model_carriers_unknown' }
  );
  // 透传未挂载的入口（anthropic messages）上家族通道不作数 → 家族承载者也算「非透传」→ 交还。
  assert.deepEqual(
    explainGoRouteDeferral({
      entryId: MESSAGES_ENTRY,
      model: 'hy4-preview',
      state: {
        accounts: { workbuddy: [{ accountRef: LIVE }], kimi: [{ accountRef: DOWN }] },
        modelAccountIndex: indexFor([[LIVE, 'workbuddy', ['hy4-preview']]])
      },
      goRoutableModelIds: routable('hy4-preview')
    }),
    { defer: true, reason: 'pool_has_non_go_servable_provider' }
  );
  // 池里全为 Go 可服务 Provider：模型级判定不参与，旧语义的充分条件仍然成立。
  assert.deepEqual(
    explainGoRouteDeferral({
      entryId: INFERENCE_ENTRY,
      model: 'hy4-preview',
      state: { accounts: { workbuddy: [{ accountRef: LIVE }] } },
      goRoutableModelIds: routable('hy4-preview')
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
