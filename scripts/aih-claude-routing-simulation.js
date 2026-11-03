#!/usr/bin/env node
'use strict';

// 真实调用生产路由代码（不是重新实现一遍逻辑）模拟 `aih claude`（.aih-server 网关 profile）
// 场景下每一轮请求实际会轮询到哪个 provider 的哪个账号：
//   1. lib/server/model-alias-resolver  -> 判断请求模型是否命中用户配置的模型别名（alias hit / direct hit）
//   2. lib/server/capability-router     -> 决定最终落到哪个 provider（model_family / alias_target_provider / ...）
//   3. lib/server/request-orchestrator + account-selector -> 在该 provider 的账号池里真实轮询选账号
//
// 用法：node scripts/aih-claude-routing-simulation.js [--rounds=30] [--seed=1]

const { resolveGatewayProvider } = require('../lib/server/capability-router');
const {
  resolveModelAliasCandidates,
  applyAliasCandidate
} = require('../lib/server/model-alias-resolver');
const { chooseServerAccount } = require('../lib/server/account-selector');
const { runWithAccountAttempts } = require('../lib/server/request-orchestrator');

function parseArgs(argv) {
  const args = { rounds: 30, seed: 1 };
  argv.forEach((raw) => {
    const m = String(raw || '').match(/^--([^=]+)=(.*)$/);
    if (!m) return;
    args[m[1]] = m[2];
  });
  args.rounds = Math.max(1, Number(args.rounds) || 30);
  args.seed = Number(args.seed) || 1;
  return args;
}

// 确定性伪随机数（不用 Math.random，方便复现同一份"轮询轨迹"）
function makeRng(seed) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state / 0xffffffff;
  };
}

const now = Date.now();

// ---- 账号池 fixture：模拟真实网关状态 state.accounts -----------------------
// claude: 3 个账号，其中 1 个正在冷却（模拟 429 熔断），验证"aih claude"是否只在
// claude 自己的账号池里轮询，不会借用别的 provider。
const state = {
  strategy: 'round-robin',
  cursors: {},
  // 注意：accountRef 必须满足生产代码里 isAccountRef 的格式校验（acct_ + 20 位
  // [a-f0-9]），否则 model-capability-index 里 getAccountRef() 会静默判定该账号
  // "无有效 ref"，跳过按模型能力路由（model_capability / alias_requested_model_capability）
  // 这条分支——第一版脚本正是踩了这个坑，导致本该路由到 agy 的用例被误判成走了
  // protocol-route 兜底。这里全部换成合法格式的假 ref。
  accounts: {
    claude: [
      {
        id: 'claude-A', accountRef: 'acct_aaaaaaaaaaaaaaaaaaaa', provider: 'claude',
        accessToken: 'tok-claude-A', email: 'claude-a@example.com',
        availableModels: ['claude-opus-4-6-thinking', 'claude-sonnet-5', 'claude-haiku-4-5']
      },
      {
        id: 'claude-B', accountRef: 'acct_bbbbbbbbbbbbbbbbbbbb', provider: 'claude',
        accessToken: 'tok-claude-B', email: 'claude-b@example.com',
        availableModels: ['claude-opus-4-6-thinking', 'claude-sonnet-5', 'claude-haiku-4-5']
      },
      {
        id: 'claude-C', accountRef: 'acct_cccccccccccccccccccc', provider: 'claude',
        accessToken: 'tok-claude-C', email: 'claude-c@example.com',
        availableModels: ['claude-opus-4-6-thinking', 'claude-sonnet-5', 'claude-haiku-4-5'],
        cooldownUntil: now + 5 * 60 * 1000 // 熔断中，5 分钟后才恢复
      }
    ],
    codex: [
      {
        id: 'codex-A', accountRef: 'acct_dddddddddddddddddddd', provider: 'codex',
        accessToken: 'tok-codex-A', email: 'codex-a@example.com',
        availableModels: ['gpt-5.5']
      },
      {
        id: 'codex-B', accountRef: 'acct_eeeeeeeeeeeeeeeeeeee', provider: 'codex',
        accessToken: 'tok-codex-B', email: 'codex-b@example.com',
        availableModels: ['gpt-5.5'],
        cooldownUntil: now + 60 * 60 * 1000 // 全池熔断场景：codex 唯一另一账号也在冷却
      }
    ],
    agy: [
      {
        id: 'agy-A', accountRef: 'acct_ffffffffffffffffffff', provider: 'agy',
        accessToken: 'tok-agy-A', email: 'agy-a@example.com',
        // agy 可以镜像服务部分 claude-* 模型（Anthropic 直连协议），用来验证
        // "被显式 alias 指过去" 与 "被 strict family routing 拦下" 两种分支。
        availableModels: ['claude-sonnet-4-6']
      }
    ],
    gemini: [],
    opencode: [],
    grok: [],
    kimi: [],
    kiro: [],
    qoder: []
  },
  webUiModelsCache: {
    byProvider: {
      claude: ['claude-opus-4-6-thinking', 'claude-sonnet-5', 'claude-haiku-4-5'],
      codex: ['gpt-5.5'],
      agy: ['claude-sonnet-4-6']
    }
  }
};

// ---- 模型别名 fixture：模拟"设置->模型别名"里用户配置的记录 ------------------
const aliases = [
  // 1) 直连命中：alias 名字本身就是 claude 家族模型的"马甲"，显式指回 claude。
  { id: 'alias1', alias: 'claude-max', target: 'claude-opus-4-6-thinking', provider: 'all', targetProvider: 'claude', priority: 0, enabled: true },
  // 2) 通配符命中：claude-sonnet-* 统一收敛到 claude-sonnet-5，仍是 claude 家族。
  { id: 'alias2', alias: 'claude-sonnet-*', target: 'claude-sonnet-5', provider: 'all', targetProvider: 'claude', priority: 0, enabled: true },
  // 3) 跨 provider 命中：用户把一个"看起来像 claude"的别名指去了 codex —— 这是
  //    验证"轮询是否会因为 alias 配置错误而跑到别的 provider 账号"的关键用例。
  { id: 'alias3', alias: 'claude-cheap', target: 'gpt-5.5', provider: 'all', targetProvider: 'codex', priority: 0, enabled: true },
  // 4) auto 目标 provider：别名没写死 provider，交给 capability-router 按模型家族推断。
  { id: 'alias4', alias: 'claude-mirror', target: 'claude-sonnet-4-6', provider: 'all', targetProvider: 'auto', priority: 0, enabled: true }
];

// `aih claude` 的 .aih-server profile 把 ANTHROPIC_BASE_URL 指到本地网关根路径，
// Claude Code CLI 自己发出的都是标准 Anthropic Messages 协议请求。
const CLIENT_PROTOCOL = 'anthropic_messages';

// 模拟客户端在不同轮次里可能发出的 model 字段：
// - 前几个是真实 claude 模型名（没有任何别名匹配) -> 期望 direct hit
// - 后几个是用户配置过的别名名字 -> 期望 alias hit，其中 claude-cheap 会跨到 codex
const REQUEST_MODEL_POOL = [
  'claude-opus-4-6-thinking',
  'claude-sonnet-5',
  'claude-haiku-4-5',
  'claude-max',
  'claude-sonnet-turbo', // 匹配通配符 claude-sonnet-*
  'claude-cheap',
  'claude-mirror'
];

function findOwningProvider(accountRef) {
  return Object.keys(state.accounts).find((provider) => (
    state.accounts[provider].some((acct) => acct.accountRef === accountRef)
  )) || '(none)';
}

async function simulateOneRequest(requestedModel) {
  const requestJson = { model: requestedModel };

  const aliasCandidatesContext = resolveModelAliasCandidates({
    aliases,
    requestJson,
    clientProtocol: CLIENT_PROTOCOL,
    options: { provider: 'auto' },
    headers: {},
    state
  });
  const candidate = aliasCandidatesContext.candidates[0] || null;
  const aliasContext = applyAliasCandidate({
    requestJson,
    candidate,
    baseProvider: aliasCandidatesContext.baseProvider
  });

  const gatewayResult = resolveGatewayProvider({
    options: { provider: 'auto' },
    state,
    requestJson: aliasContext.requestJson,
    headers: {},
    aliasTargetProvider: aliasContext.aliasTargetProvider,
    preferModelRouting: aliasContext.preferModelRouting,
    aliasResolution: aliasContext.aliasResolution,
    clientProtocol: CLIENT_PROTOCOL
  });

  const matchType = !aliasContext.changed
    ? 'direct'
    : `alias:${candidate.matchType}`;

  if (!gatewayResult.provider) {
    return {
      requestedModel,
      effectiveModel: aliasContext.requestJson.model,
      matchType,
      provider: '(none)',
      source: gatewayResult.source,
      error: gatewayResult.error,
      accountRef: '(none)',
      owningProvider: '(none)'
    };
  }

  const pool = state.accounts[gatewayResult.provider] || [];
  const orchestration = await runWithAccountAttempts({
    pool,
    maxAttempts: Math.max(1, pool.length),
    chooseServerAccount,
    selectionState: state,
    cursorState: state.cursors,
    cursorKey: gatewayResult.provider, // 生产代码里 cursorKey 就是 provider 本身：轮询游标按 provider 维度累积
    provider: gatewayResult.provider,
    model: aliasContext.requestJson.model,
    strategy: state.strategy,
    sessionKey: '',
    onAttempt: async (account) => ({ action: 'return', value: account })
  });

  const account = orchestration.kind === 'returned' ? orchestration.value : null;
  const accountRef = account ? account.accountRef : '(none)';

  return {
    requestedModel,
    effectiveModel: aliasContext.requestJson.model,
    matchType,
    provider: gatewayResult.provider,
    source: gatewayResult.source,
    error: orchestration.kind !== 'returned' ? orchestration.kind : '',
    accountRef,
    owningProvider: account ? findOwningProvider(accountRef) : '(none)'
  };
}

async function main() {
  const { rounds, seed } = parseArgs(process.argv.slice(2));
  const rng = makeRng(seed);

  const rows = [];
  for (let i = 0; i < rounds; i += 1) {
    const requestedModel = REQUEST_MODEL_POOL[Math.floor(rng() * REQUEST_MODEL_POOL.length)];
    // eslint-disable-next-line no-await-in-loop
    const row = await simulateOneRequest(requestedModel);
    rows.push({ round: i + 1, ...row });
  }

  const header = ['round', 'requestedModel', 'matchType', 'provider', 'source', 'accountRef', 'owningProvider', 'error'];
  const widths = header.map((h) => Math.max(h.length, ...rows.map((r) => String(r[h] ?? '').length)));
  const fmtRow = (values) => values.map((v, idx) => String(v ?? '').padEnd(widths[idx])).join('  ');
  console.log(fmtRow(header));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  rows.forEach((r) => console.log(fmtRow(header.map((h) => r[h]))));

  console.log('\n--- 汇总 ---');
  const byRequestedModel = {};
  rows.forEach((r) => {
    const key = r.requestedModel;
    byRequestedModel[key] = byRequestedModel[key] || { matchType: r.matchType, providers: {}, accounts: {} };
    byRequestedModel[key].providers[r.provider] = (byRequestedModel[key].providers[r.provider] || 0) + 1;
    byRequestedModel[key].accounts[r.accountRef] = (byRequestedModel[key].accounts[r.accountRef] || 0) + 1;
  });
  Object.entries(byRequestedModel).forEach(([model, info]) => {
    console.log(`model="${model}" matchType=${info.matchType} -> provider分布=${JSON.stringify(info.providers)} 账号分布=${JSON.stringify(info.accounts)}`);
  });

  console.log('\n--- 关键结论校验 ---');
  const directClaudeRows = rows.filter((r) => r.matchType === 'direct' && r.requestedModel.startsWith('claude') && r.requestedModel !== 'claude-cheap' && r.requestedModel !== 'claude-mirror' && r.requestedModel !== 'claude-max');
  const leaked = directClaudeRows.filter((r) => r.provider !== 'claude' || (r.accountRef !== '(none)' && r.owningProvider !== 'claude'));
  console.log(`1) 未命中任何别名的真实 claude-* 请求数=${directClaudeRows.length}，其中落到非 claude 账号池的数量=${leaked.length} ${leaked.length === 0 ? '(通过：全部走 direct hit + model_family，未借用其它 provider 账号)' : '(异常，见上表)'}`);

  const aliasCheapRows = rows.filter((r) => r.requestedModel === 'claude-cheap');
  const cheapWrong = aliasCheapRows.filter((r) => r.provider !== 'codex');
  console.log(`2) 别名 "claude-cheap"（配置为跨到 codex）命中次数=${aliasCheapRows.length}，未落到 codex 的次数=${cheapWrong.length} ${aliasCheapRows.length > 0 && cheapWrong.length === 0 ? '(通过：alias_target_provider 显式跨 provider 生效)' : ''}`);

  const claudeAssignedRefs = rows.filter((r) => r.provider === 'claude' && r.accountRef !== '(none)').map((r) => r.accountRef);
  console.log(`3) 分配给 claude 请求的账号 ref 去重后=${JSON.stringify([...new Set(claudeAssignedRefs)])}（应只包含 claude 池内账号，且不含冷却中的 acct_cccccccccccccccccccc）`);

  // 专项场景：codex 家族模型请求，但 codex 池全部熔断——验证 strict family lock
  // 是否老实返回 no_account_supports_model，而不是静默借用 claude/agy 的账号
  // "帮忙顶上"（历史上出现过的误路由 bug 就是这种"family 没账号却兜底去别的
  // provider account池"）。
  console.log('\n--- 专项场景：codex 全池熔断，验证不会借用 claude/agy 账号 ---');
  const codexExhaustedState = JSON.parse(JSON.stringify(state));
  codexExhaustedState.cursors = {};
  codexExhaustedState.accounts.codex.forEach((acct) => { acct.cooldownUntil = now + 60 * 60 * 1000; });
  const savedState = state.accounts.codex;
  const savedCursors = state.cursors;
  state.accounts.codex = codexExhaustedState.accounts.codex;
  state.cursors = codexExhaustedState.cursors;
  const exhaustedResult = await simulateOneRequest('gpt-5.5');
  state.accounts.codex = savedState;
  state.cursors = savedCursors;
  const borrowedOtherProvider = exhaustedResult.provider && exhaustedResult.provider !== '(none)';
  console.log(`gpt-5.5 请求 -> provider=${exhaustedResult.provider} source=${exhaustedResult.source} error=${exhaustedResult.error} ${!borrowedOtherProvider ? '(通过：家族无可用账号时正确返回不可用，未借用别的 provider)' : '(异常：不应该有 provider 结果)'}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
