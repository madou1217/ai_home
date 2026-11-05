'use strict';

// goCoreSync 门面：WebUI / 管理接口「编辑即推送」到 Go Core 的唯一入口。
//
// 为什么需要这层：这些转发原本手写在 server.js 里，每新增一个 Go 能力就要在 server.js
// 加一行，而 server.js 本身就是改动最频繁的文件。把方法清单收敛到 FACADE_METHODS 后，
// 新增能力只改这个数组，server.js 不再因转发而改动。
//
// 为什么不直接把宿主透出去：goCoreHost 上还有启停、转发目标探测、运行态上报等内部能力，
// 它们属于宿主自身职责，不应该顺着 deps.goCoreSync 流进 WebUI 路由。门面只暴露清单里的
// 名字，能力边界是显式的。
//
// 为什么缺方法要在装配期抛错：静默跳过会退化成「编辑成功但从不推送」的隐性错误，只有
// 线上行为异常时才暴露；装配期红掉能立刻指到是宿主少实现了哪个方法。

/**
 * 门面暴露的方法名。新增 Go 能力时只在这里加一项，server.js 不需要改。
 * 顺序即 Object.keys(facade) 的顺序，测试用它作为唯一真值源。
 */
const FACADE_METHODS = Object.freeze([
  // 投影推送（见 go-core-projection-sync）：WebUI 编辑后即时同步给 Go，不等兜底定时器。
  'pushModelAliases',
  'pushUpstreamErrorRules',
  // OAuth Job 公开快照：Node 只投影公开字段，Go 负责跨重启持久化与查询。
  'pushOAuthJob',
  'listOAuthJobs',
  'getOAuthJob',
  // codex/claude 静态凭据编辑：唯一写入口是 Go。
  'isEnabled',
  'editStaticCredential',
  'setAccountEnabled',
  'setProviderDefault',
  'clearProviderDefault',
  'importAccounts',
  'exportAccounts',
  'deleteAccount',
  // 额度统计的计算在 Go：WebUI 路由通过门面取结果（见 webui-account-quota-stats-routes）。
  'getQuotaStats',
  // 账号导入后的对账：webui-account-routes-import.js 会调用它。
  // 之前手写门面漏了这项，导入后的「立刻对账」一直是静默跳过的死路径。
  'reconcileAccounts'
]);

/**
 * 依据 FACADE_METHODS 生成转发门面。
 *
 * @param {object} goCoreHost createGoCoreHost() 的返回值
 * @returns {Readonly<Record<string, Function>>}
 */
function createGoCoreSyncFacade(goCoreHost) {
  if (!goCoreHost || typeof goCoreHost !== 'object') {
    throw new TypeError('createGoCoreSyncFacade: 需要 goCoreHost 实例');
  }
  const facade = {};
  for (const name of FACADE_METHODS) {
    if (typeof goCoreHost[name] !== 'function') {
      throw new TypeError(`createGoCoreSyncFacade: goCoreHost 缺少方法 ${name}()`);
    }
    // 每次调用都从宿主取方法，保持「门面只是转发」的语义：宿主换实现不需要重建门面，
    // 且 this 仍指向宿主（与原手写转发 arrow 调用一致）。
    facade[name] = (...args) => goCoreHost[name](...args);
  }
  // 冻结：门面是固定的能力表，运行期往上挂方法就等于绕过清单偷偷扩大暴露面。
  return Object.freeze(facade);
}

module.exports = {
  FACADE_METHODS,
  createGoCoreSyncFacade
};
