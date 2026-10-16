'use strict';

// 账号实例注册表：生命周期内一个 accountRef 只对应一个账号对象。
//
// 为什么需要它：账号状态（冷却 / 连击 / 额度 / 故障计数）必须只有一份真相。此前的做法是
// 每个派生索引（model-account-index、model-capability-index）各自用
// `Object.create(account)` + Proxy 造一份「账号视图」，靠 set 穿透把写入转回真身。
// 那是补丁不是设计，后果有三个：
//
//   1. 同一段 buildIndexedAccount 被逐字节抄了两份（两个索引各一份），改一处漏一处；
//   2. 索引重建（buildModelAccountIndex / applyReloadState）会换掉整批视图对象，
//      实例身份在重建时刻断裂——引用旧视图的代码读到的是冻结的冷却状态；
//   3. 读取侧必须记得「索引里的账号和 state.accounts 里的账号不是同一个对象」，
//      任何一处忘了穿透，状态就不一致。
//
// 本模块把「身份」收敛到一处：注册表按 accountRef 持有唯一实例，索引只存 accountRef。
// 注册表不复制对象——它持有传入的那个对象本身，所以写入天然落在同一份状态上，
// 不需要 Proxy、不需要 Object.create、不需要重建后重绑。
//
// 与「账号池」的关系：池是**筛选结果**（按模型/Provider/别名条件从注册表里选出若干 ref），
// 不是账号状态的第二份持有者。池里只存 id，需要实例时向注册表取。

// accountRef 的形态判定复用既有唯一实现，避免第二份正则与 sqlite CHECK 约束漂移。
const { isAccountRef } = require('../account/public-account-ref');

/**
 * 账号实例注册表。
 *
 * 语义保证：
 *  - `register(ref, account)` 后，`get(ref)` 返回**同一个对象引用**，直到 `unregister`；
 *  - `register` 同一个 ref 且传入同一对象时是幂等的；
 *  - `register` 同一个 ref 但传入**不同**对象时，以新对象替换（重载语义），并让旧对象
 *    成为孤儿——这是唯一允许身份变化的时刻，且只发生在显式重载时；
 *  - 没有任何隐式复制、Proxy 或原型链包装。
 */
function createAccountInstanceRegistry() {
  /** @type {Map<string, object>} */
  const instances = new Map();
  // ref → provider。与实例分开存：provider 是索引键的一部分，而实例字段（如 provider）
  // 可能被上游写入覆盖，索引不能依赖实例字段来分组。
  const providers = new Map();

  function normalizeRef(ref) {
    const value = String(ref || '').trim();
    return isAccountRef(value) ? value : '';
  }

  function register(ref, account, provider = '') {
    const accountRef = normalizeRef(ref);
    if (!accountRef || !account || typeof account !== 'object') return null;
    const normalizedProvider = String(provider || account.provider || '').trim().toLowerCase();
    instances.set(accountRef, account);
    if (normalizedProvider) providers.set(accountRef, normalizedProvider);
    return account;
  }

  function unregister(ref) {
    const accountRef = normalizeRef(ref);
    if (!accountRef) return false;
    providers.delete(accountRef);
    return instances.delete(accountRef);
  }

  function get(ref) {
    const accountRef = normalizeRef(ref);
    return accountRef ? instances.get(accountRef) || null : null;
  }

  function providerOf(ref) {
    const accountRef = normalizeRef(ref);
    if (!accountRef) return '';
    const cached = providers.get(accountRef);
    if (cached) return cached;
    // 实例自己带 provider 时补登记，避免调用方必须先声明。
    const account = instances.get(accountRef);
    const provider = String(account && account.provider || '').trim().toLowerCase();
    if (provider) providers.set(accountRef, provider);
    return provider;
  }

  function has(ref) {
    return instances.has(normalizeRef(ref));
  }

  function refs() {
    return Array.from(instances.keys());
  }

  function size() {
    return instances.size;
  }

  /**
   * 按 Provider 取全部实例 ref。索引按 provider 分组时用这个，不再遍历 state.accounts。
   */
  function refsForProvider(provider) {
    const target = String(provider || '').trim().toLowerCase();
    if (!target) return [];
    const out = [];
    for (const [ref, owner] of providers) {
      if (owner === target) out.push(ref);
    }
    return out;
  }

  /**
   * 清空并重新装载。用于整体重载：调用方先清，再逐个 register。
   * 刻意不提供「批量替换」以外的语义——重载是唯一允许身份变化的时刻。
   */
  function clear() {
    instances.clear();
    providers.clear();
  }

  /**
   * 只保留给定集合里的 ref，其余全部移除。
   *
   * 全量重建索引时用：注册表是跨重建存活的（挂在 state 上），如果只 register 不清理，
   * 已删除的账号会以陈旧条目留在容器里，而按 accountByRef 遍历的读取方（例如
   * 「这个 Provider 的目录是否未知」的判定）会把它们算进去。
   */
  function retain(validRefs) {
    const keep = new Set();
    (validRefs instanceof Set ? validRefs : Array.from(validRefs || []))
      .forEach((ref) => {
        const accountRef = normalizeRef(ref);
        if (accountRef) keep.add(accountRef);
      });
    for (const ref of Array.from(instances.keys())) {
      if (keep.has(ref)) continue;
      providers.delete(ref);
      instances.delete(ref);
    }
  }

  return {
    register,
    unregister,
    get,
    providerOf,
    has,
    refs,
    refsForProvider,
    size,
    clear,
    retain,
    // 唯一真相：ref → 实例 的那张 Map 本身。
    //
    // 暴露它而不是让每个消费方各存一份，是本模块存在的理由。此前的两份索引各建一个
    // `accountByRef` Map，都往里写账号状态——同一份状态被两个容器持有，谁写谁不写没有
    // 合同约束，于是要靠 Proxy 写穿透维持一致。现在容器只有一个，消费方持有的是对它的
    // **引用**，不是副本：任一处的写入，其他处立即可见。
    //
    // 读取（get/has/entries/values/forEach/size）与写入（set/delete）都可直接用；
    // 但**登记新实例请走 register**——它负责 ref 规范化与 provider 绑定，直接 set 会绕过。
    byRef: instances
  };
}

module.exports = {
  createAccountInstanceRegistry
};
