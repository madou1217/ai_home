'use strict';

// 回归守卫（2026-11-04）：CodeBuddy 家族 CLI 在会话内 /model 切模型后，
//   * 当前模型不能被启动参数 --model 顶回去；
//   * codebuddy ↔ codebuddycn 换号要按目标账号目录选一个能用的模型。
// 旧行为：resolveActiveModelLabel 无条件 `explicit > configured`，换号也原样
// 透传 --model —— 切完模型换号，模型被悄悄回退，跨站时还会把只属于原站的模型
// 带到目标站（第一次请求才报 service info not found）。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createFamilyModelTracker,
  decideFamilySwitchModel,
  pickActiveModel,
  planSwitchModel,
  selectAccountCatalog,
  setModelFlagValue
} = require('../lib/cli/services/pty/active-model');

// 2026-11-04 本机真实目录（codebuddy #1 / codebuddycn #1）。
const GLOBAL_MODELS = [
  'balanced-model', 'deepseek-v4.1-flash', 'deepseek-v4.1-flash-sg', 'default-model',
  'fast-model', 'gemini-3.8-flash', 'glm-5.2', 'glm-5.3', 'glm-5.3-flash',
  'gpt-5.4', 'gpt-5.5', 'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra',
  'gpt-6-astra', 'gpt-6-luna', 'gpt-6-sol', 'gpt-6.1-sol', 'grok-4.7',
  'hy3', 'hy4-preview', 'kimi-k3', 'kimi-k3.1-pro', 'kimi-k3.1-pro-highspeed',
  'minimax-m3.1-flash', 'primary-model'
];
const CN_MODELS = [
  'deepseek-v4-pro', 'deepseek-v4.1-flash', 'glm-5.2', 'glm-5.3', 'glm-5.3-flash',
  'glm-5.3-flashx', 'hy3', 'hy3-x', 'hy4free', 'hy4std', 'kimi-k2.8-preview',
  'kimi-k3-2', 'kimi-k3.1-pro', 'kimi-k3.1-pro-highspeed', 'mimo-v2.6-pro',
  'minimax-m2.7', 'minimax-m3-pay', 'minimax-m3.1-flash', 'space-bunny', 'step-5-preview'
];

test('运行中 /model 切换压过启动参数，且切换回旧值也能识别', () => {
  const tracker = createFamilyModelTracker();
  tracker.reset('gpt-6.1-sol', 'gpt-6.1-sol');
  assert.equal(pickActiveModel({
    live: tracker.observe('gpt-6.1-sol'),
    explicit: 'gpt-6.1-sol',
    configured: 'gpt-6.1-sol'
  }), 'gpt-6.1-sol');

  // TUI 内 /model → settings.json 变成 glm-5.3
  const live = tracker.observe('glm-5.3');
  assert.equal(live, 'glm-5.3');
  assert.equal(pickActiveModel({
    live,
    explicit: 'gpt-6.1-sol',
    configured: 'glm-5.3'
  }), 'glm-5.3');

  // 再切回启动时的模型：baseline 已前移，仍算一次变化
  assert.equal(tracker.observe('gpt-6.1-sol'), 'gpt-6.1-sol');
  assert.equal(tracker.current(), 'gpt-6.1-sol');
});

test('只有 settings.json 和启动参数不同、没有发生过变化时，启动参数仍然优先', () => {
  const tracker = createFamilyModelTracker();
  tracker.reset('glm-5.3', '');
  const live = tracker.observe('glm-5.3');
  assert.equal(live, '');
  assert.equal(pickActiveModel({
    live,
    explicit: 'gpt-6.1-sol',
    reported: '',
    configured: 'glm-5.3'
  }), 'gpt-6.1-sol');
});

test('跨站：目标站点支持当前模型时原样保留', () => {
  const decision = decideFamilySwitchModel({
    currentModel: 'deepseek-v4.1-flash',
    targetCatalog: CN_MODELS,
    siteModel: ''
  });
  assert.deepEqual(decision, { model: 'deepseek-v4.1-flash', changed: false, reason: 'supported' });
});

test('跨站：目标站点不支持时优先恢复该站上次用过的模型', () => {
  const decision = decideFamilySwitchModel({
    currentModel: 'step-5-preview', // 仅国内站
    targetCatalog: GLOBAL_MODELS,
    siteModel: 'gpt-6.1-sol'
  });
  assert.deepEqual(decision, { model: 'gpt-6.1-sol', changed: true, reason: 'site_memory' });
});

test('跨站：没有站点记忆时选目标站默认档位，而不是目录第一条', () => {
  const decision = decideFamilySwitchModel({
    currentModel: 'step-5-preview',
    targetCatalog: GLOBAL_MODELS,
    siteModel: ''
  });
  assert.equal(decision.model, 'default-model');
  assert.equal(decision.changed, true);
  assert.equal(decision.reason, 'target_default');
});

test('跨站：目标站没有默认档位时取第一条可用模型；模型 id 大小写/版本分隔符归一', () => {
  const decision = decideFamilySwitchModel({
    currentModel: 'gpt-6.1-sol',
    targetCatalog: CN_MODELS,
    siteModel: ''
  });
  assert.equal(decision.model, 'deepseek-v4-pro');
  assert.equal(decision.changed, true);

  const matched = decideFamilySwitchModel({
    currentModel: 'DeepSeek-V4.1-Flash',
    targetCatalog: CN_MODELS
  });
  assert.equal(matched.model, 'DeepSeek-V4.1-Flash');
  assert.equal(matched.reason, 'supported');
});

test('目录未知时 fail-open：保留当前模型，不猜替代项', () => {
  assert.deepEqual(decideFamilySwitchModel({
    currentModel: 'step-5-preview',
    targetCatalog: null
  }), { model: 'step-5-preview', changed: false, reason: 'catalog_unknown' });
  assert.deepEqual(decideFamilySwitchModel({
    currentModel: 'step-5-preview',
    targetCatalog: []
  }), { model: 'step-5-preview', changed: false, reason: 'catalog_unknown' });
});

test('残缺目录按未知处理，不能据此换掉用户的模型', () => {
  const cache = {
    byAccount: { acct_a: ['glm-5.3'] },
    incompleteByAccount: { acct_a: { reason: 'probe_failed' } }
  };
  assert.equal(selectAccountCatalog(cache, 'acct_a'), null);
  const decision = decideFamilySwitchModel({
    currentModel: 'step-5-preview',
    targetCatalog: selectAccountCatalog(cache, 'acct_a')
  });
  assert.equal(decision.model, 'step-5-preview');
  assert.equal(decision.reason, 'catalog_unknown');
});

test('目录里没有任何可用替代项时不动模型（宁可让上游报错，也不编一个 id）', () => {
  const decision = decideFamilySwitchModel({
    currentModel: 'step-5-preview',
    targetCatalog: ['custom-local:foo', 'chat_abc']
  });
  assert.deepEqual(decision, { model: 'step-5-preview', changed: false, reason: 'no_alternative' });
});

test('setModelFlagValue 覆盖四种写法，保留参数顺序与 -- 之后的原生参数', () => {
  assert.deepEqual(setModelFlagValue(['--model', 'a', '--resume', 's'], 'b'),
    ['--model', 'b', '--resume', 's']);
  assert.deepEqual(setModelFlagValue(['--model=a', '--resume', 's'], 'b'),
    ['--model=b', '--resume', 's']);
  assert.deepEqual(setModelFlagValue(['-m', 'a', '--resume', 's'], 'b'),
    ['-m', 'b', '--resume', 's']);
  assert.deepEqual(setModelFlagValue(['-m=a', '--resume', 's'], 'b'),
    ['-m=b', '--resume', 's']);
});

test('setModelFlagValue 缺省时插到 -- 之前，不污染原生透传区', () => {
  assert.deepEqual(setModelFlagValue(['--resume', 's', '--', '--model', 'keep'], 'b'),
    ['--resume', 's', '--model', 'b', '--', '--model', 'keep']);
  assert.deepEqual(setModelFlagValue(['--resume', 's'], 'b'),
    ['--resume', 's', '--model', 'b']);
});

test('setModelFlagValue 不吃掉紧跟的旗标（原参数缺值时不静默破坏）', () => {
  assert.deepEqual(setModelFlagValue(['--model', '--resume', 's'], 'b'),
    ['--model', 'b', '--resume', 's']);
});

test('planSwitchModel：家族换号把运行中的新模型写回参数，替换旧 --model', () => {
  const plan = planSwitchModel({
    currentModel: 'glm-5.3',
    fromProvider: 'codebuddy',
    nextProvider: 'codebuddy',
    forwardArgs: ['--model', 'gpt-6.1-sol', '--resume', 'sess-1']
  });
  assert.deepEqual(plan.args, ['--model', 'glm-5.3', '--resume', 'sess-1']);
  assert.equal(plan.model, 'glm-5.3');
  assert.equal(plan.notice, '');
  assert.equal(plan.family, true);
});

test('planSwitchModel：家族换号即使没有 --model 也显式携带当前模型（session 级切换不丢）', () => {
  const plan = planSwitchModel({
    currentModel: 'glm-5.3',
    fromProvider: 'codebuddycn',
    nextProvider: 'codebuddycn',
    forwardArgs: ['--resume', 'sess-1']
  });
  assert.deepEqual(plan.args, ['--resume', 'sess-1', '--model', 'glm-5.3']);
  assert.equal(plan.model, 'glm-5.3');
});

test('planSwitchModel：跨站不支持时显式带目标站默认模型并给出原因', () => {
  const plan = planSwitchModel({
    currentModel: 'step-5-preview',
    fromProvider: 'codebuddycn',
    nextProvider: 'codebuddy',
    forwardArgs: ['--resume', 'sess-1'],
    targetCatalog: GLOBAL_MODELS,
    siteModel: ''
  });
  assert.deepEqual(plan.args, ['--resume', 'sess-1', '--model', 'default-model']);
  assert.equal(plan.model, 'default-model');
  assert.match(plan.notice, /目标账号不支持模型 step-5-preview/);
  assert.match(plan.notice, /default-model/);
});

test('planSwitchModel：跨站支持时保留原模型，不产生替换提示', () => {
  const plan = planSwitchModel({
    currentModel: 'deepseek-v4.1-flash',
    fromProvider: 'codebuddycn',
    nextProvider: 'codebuddy',
    forwardArgs: ['--model', 'deepseek-v4.1-flash', '--resume', 'sess-1'],
    targetCatalog: GLOBAL_MODELS,
    siteModel: ''
  });
  assert.deepEqual(plan.args, ['--model', 'deepseek-v4.1-flash', '--resume', 'sess-1']);
  assert.equal(plan.model, 'deepseek-v4.1-flash');
  assert.equal(plan.notice, '');
});

test('planSwitchModel：非家族 provider 不改模型，只修正旧 --model', () => {
  const plan = planSwitchModel({
    currentModel: 'claude-sonnet-4-6',
    fromProvider: 'claude',
    nextProvider: 'claude',
    forwardArgs: ['--model', 'claude-opus-4-6', '--resume', 's']
  });
  assert.deepEqual(plan.args, ['--model', 'claude-sonnet-4-6', '--resume', 's']);
  assert.equal(plan.notice, '');
  assert.equal(plan.family, false);
});

test('planSwitchModel：带 --model-alias 时完全不碰模型（source 是规则锚点）', () => {
  const plan = planSwitchModel({
    currentModel: 'step-5-preview',
    fromProvider: 'codebuddycn',
    nextProvider: 'codebuddy',
    forwardArgs: ['--model', 'step-5-preview', '--resume', 's'],
    targetCatalog: GLOBAL_MODELS,
    hasModelAlias: true
  });
  assert.deepEqual(plan.args, ['--model', 'step-5-preview', '--resume', 's']);
  assert.equal(plan.model, 'step-5-preview');
  assert.equal(plan.notice, '');
});

test('planSwitchModel：模型 id 不截断，且不把 -- 之后的原生 --model 当会话模型', () => {
  const longModel = 'vendor/' + 'x'.repeat(60);
  const plan = planSwitchModel({
    currentModel: longModel,
    fromProvider: 'codebuddy',
    nextProvider: 'codebuddy',
    forwardArgs: ['--resume', 's', '--', '--model', 'native-model']
  });
  assert.deepEqual(plan.args, ['--resume', 's', '--model', longModel, '--', '--model', 'native-model']);
  assert.equal(plan.model, longModel);
});

test('端到端状态链：启动 --model → /model → 同站换号 → 跨站换号', () => {
  // 启动：aih codebuddy 1 --model gpt-6.1-sol（settings 也是 gpt-6.1-sol）
  const tracker = createFamilyModelTracker();
  tracker.reset('gpt-6.1-sol', 'gpt-6.1-sol');

  // TUI 内 /model glm-5.3：settings 写入新值
  const live = tracker.observe('glm-5.3');
  const current = pickActiveModel({
    live,
    explicit: 'gpt-6.1-sol',
    configured: 'glm-5.3'
  });
  assert.equal(current, 'glm-5.3');

  // 同站换号：启动参数里的旧 --model 必须被替换，否则新账号回到旧模型
  const sameSite = planSwitchModel({
    currentModel: current,
    fromProvider: 'codebuddy',
    nextProvider: 'codebuddy',
    forwardArgs: ['--model', 'gpt-6.1-sol', '--resume', 'sess-1']
  });
  assert.deepEqual(sameSite.args, ['--model', 'glm-5.3', '--resume', 'sess-1']);

  // 跨到国内站：glm-5.3 两边都有，保留
  const crossSite = planSwitchModel({
    currentModel: sameSite.model,
    fromProvider: 'codebuddy',
    nextProvider: 'codebuddycn',
    forwardArgs: sameSite.args,
    targetCatalog: CN_MODELS,
    siteModel: ''
  });
  assert.equal(crossSite.model, 'glm-5.3');
  assert.equal(crossSite.notice, '');

  // 国内站切到只属于本地的 step-5-preview，再切回国际站：
  // 优先恢复国际站上次用过的 gpt-6.1-sol，而不是把 step-5-preview 带过去。
  const back = planSwitchModel({
    currentModel: 'step-5-preview',
    fromProvider: 'codebuddycn',
    nextProvider: 'codebuddy',
    forwardArgs: ['--model', 'step-5-preview', '--resume', 'sess-1'],
    targetCatalog: GLOBAL_MODELS,
    siteModel: 'gpt-6.1-sol'
  });
  assert.deepEqual(back.args, ['--model', 'gpt-6.1-sol', '--resume', 'sess-1']);
  assert.match(back.notice, /step-5-preview/);
  assert.match(back.notice, /gpt-6.1-sol/);
});

