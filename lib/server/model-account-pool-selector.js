'use strict';

const {
  buildModelCapabilityIndex,
  getAccountRef,
  listAvailableAccountRefsForModelProvider
} = require('./model-capability-index');
const { findRoutableAccountsForModel } = require('./model-account-index');
const {
  excludeAccountsWithoutModel,
  narrowPoolByModelCatalog
} = require('./model-pool-narrowing');

/**
 * 「请求模型 → provider 账号池」唯一收窄入口。
 *
 * 之前 codex-adapter 和 upstream-endpoints 各抄了一份同样的三段逻辑，两份实现随即
 * 各自演化：一次整文件覆盖式提交把 codex 那份的倒排索引分支悄悄抹掉（e203954 → 4df07f1），
 * 单元测试因为回退路径也能给出同样结论而全绿，回归就这么溜了过去。收敛成一个模块，
 * 是为了让「路由该怎么挑账号」只有一处可改、也只有一处需要测。
 *
 * 三步，强证据优先：
 * 1. 反向排除——目录已知且明确不含该模型的账号直接出局，任何后续放行分支都不得再碰它；
 * 2. 全局倒排索引正向收窄——O(1) 拿到真正支持该模型且当前可调度的账号，并保留其优先级；
 * 3. 索引未建时回退 capability index——冷启动兜底，语义与步骤 2 一致。
 *
 * 第 1 步是这个模块存在的理由：第 2、3 步查不到绑定时都会整池放行（探测残缺不能当否定
 * 证据），而放行会把 ollama 这类「目录里压根没有 gpt-5.6-luna」的中转账号一并放回轮询，
 * 于是出现账号漂移 + 上游 400。弱证据放行、强证据排除，两者并不矛盾。
 */
function selectPoolAccountsForModel(input) {
  const originalPool = input && input.pool;
  const pool = Array.isArray(originalPool) ? originalPool : [];
  const provider = String((input && input.provider) || '').trim().toLowerCase();
  const model = String((input && input.model) || '').trim();
  const state = input && input.state;
  const options = (input && input.options) || {};

  if (!provider || !model || pool.length < 1) {
    return { pool: originalPool, filtered: false, accountRefs: [] };
  }

  const modelIndex = state && state.modelAccountIndex;

  // 1. 强证据排除。目录来自倒排索引（webUiModelsCache.byAccount + account.availableModels），
  //    刻意不用 capability index：后者会把 --codex-models 之类的 provider 级模型摊给每个
  //    账号，拿它做否定判断会把「所有账号都支持」当成事实，排除就成了空转。
  const exclusion = excludeAccountsWithoutModel({
    pool,
    provider,
    model,
    accountCatalogs: modelIndex && modelIndex.accountToModels,
    getAccountRef
  });
  const excludedAccountRefs = exclusion.excludedAccountRefs;
  if (exclusion.pool.length < 1) {
    // 池内每个账号的目录都已知、且都不含该模型 —— 这是真的没有账号能服务，
    // 由调用方渲染 no_available_account，而不是拨一个已知不支持的上游去换 400。
    return { pool: [], filtered: true, accountRefs: [], excludedAccountRefs };
  }
  const candidatePool = exclusion.pool;
  const withExclusion = (result) => (
    excludedAccountRefs.length > 0
      ? { ...result, filtered: true, excludedAccountRefs }
      : result
  );

  // 2. 倒排索引正向收窄。
  if (modelIndex && modelIndex.builtAt > 0) {
    // 必须带 provider：倒排索引全 provider 共用，中转账号常把别家的裸模型 id 收进目录。
    // 不带 provider 查会拿到别家账号的 ref，映射回本池必然为空。
    return withExclusion(narrowPoolByModelCatalog({
      pool: candidatePool,
      provider,
      model,
      accountRefs: findRoutableAccountsForModel(modelIndex, model, provider),
      accountCatalogs: modelIndex.accountToModels,
      providerCatalog: null,
      getAccountRef,
      orderByAccountRefs: true,
      // 倒排索引没有 provider 级目录佐证，查不到绑定只说明索引不完整，
      // 这条路径永远不下「没有账号能服务」的终判。
      allowNoAccountVerdict: false
    }));
  }

  // 3. 回退：索引尚未构建（冷启动）时用 capability index。
  const index = buildModelCapabilityIndex(state, options);
  const providerModels = index.providerModels && index.providerModels.get(provider);
  if (!(providerModels instanceof Set) || providerModels.size < 1) {
    return withExclusion({
      pool: candidatePool,
      filtered: false,
      accountRefs: [],
      unchecked: true
    });
  }
  return withExclusion(narrowPoolByModelCatalog({
    pool: candidatePool,
    provider,
    model,
    accountRefs: listAvailableAccountRefsForModelProvider(index, model, provider),
    accountCatalogs: index.accountModels,
    providerCatalog: providerModels,
    getAccountRef
  }));
}

module.exports = {
  selectPoolAccountsForModel
};
