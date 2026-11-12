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
  // 只读插件清单：/v0/plugins 固定读 Go，Node 不再构建本地清单。
  'getPluginInventory',
  // 插件安装/卸载：制品校验、签名与状态 CAS 已收敛到 Go；启停仍走 Node。
  'installPlugin',
  'uninstallPlugin',
  // enable/disable 的控制状态 CAS 提交（Go 是唯一写者）与实例启停入口（P2 已切 Go）。
  'commitPluginState',
  // SSH 远端目录浏览（Go 进程内 SSH）。
  'browseSshHost',
  'getSlashCommands',
  'setWebUIMobile',
  'clearWebUIMobile',
  'setWebUIDefault',
  'clearWebUIDefault',
  'updateAccountRoutingRules',
  'restoreAccountScheduling',
  'getSessionMessages',
  'getSessionEvents',
  'getGitDiff',
  'getGitSummary',
  'getSessionPreviews',
  'getToolkitEnvironments',
  'getProjects',
  // 单项目完整会话集合：Go 全量扫描，Node 对未覆盖项目回退本地实现。
  'getProjectSessions',
  // 项目运行态 SSE 与显式快照：Go 用真实文件/hook 事件驱动，Node 只透传。
  'watchProjects',
  'requestProjectsSnapshot',
  'getSshReverseTunnels',
  'reconcileSshReverseTunnels',
  'watchSshReverseTunnels',
  'enablePlugin',
  'disablePlugin',
  // 插件发布者信任根：读/写/撤销都走 Go，WebUI 不再直接改本地文件。
  'getPluginTrustedKeys',
  'addPluginTrustedKey',
  'removePluginTrustedKey',
  // 应用启动权限设置只读模型：GET 固定读 Go，PUT 仍留在 Node。
  'getToolAppSettings',
  // WebUI 终端：会话/PTY/SSE 全部归 Go，Node 只做管理密钥门后的反代与进程内启动。
  'terminalRequest',
  'openTerminalStream',
  // OAuth Job 公开快照：Node 只投影公开字段，Go 负责跨重启持久化与查询。
  'pushOAuthJob',
  'listOAuthJobs',
  'getOAuthJob',
  // Codex 浏览器登录接 Go account-auth-jobs（实验开关，默认关）：
  // Begin 拿 job_id + authorization_url，回调原样转发，取消时释放 pending Job。
  'startAccountAuthJob',
  'completeAccountAuthJob',
  'cancelAccountAuthJob',
  // 原地重新认证由 Go 起作业；快照 SSE 让 Node 继续产出 auth-job 事件。
  'reauthAccount',
  'watchAccountAuthJob',
  // codex/claude 静态凭据编辑：唯一写入口是 Go。
  'isEnabled',
  'editStaticCredential',
  'setAccountEnabled',
  'setAccountStatus',
  'setProviderDefault',
  'clearProviderDefault',
  'importAccounts',
  'exportAccounts',
  'deleteAccount',
  // 别名影子对账与写入口：只读用于对账，写入口供切片 C 翻转后使用。
  'listModelAliases',
  // 账号页影子对账：只读 Go 的账号事实。
  'listManagementAccounts',
  // 账号页读模型：账号列表的**行来源**（Go 决定有哪些账号，Node 只补运行态富化）。
  'listWebUiAccounts',
  // 单账号事实：watch 增量事件与单账号响应装配用（只读）。
  'getManagementAccount',
  // 探针结果上报（Node 执行探针，Go 落库）。
  'pushAccountProbe',
  // 用量时间桶（额度统计页图表）。
  'getUsageBuckets',
  // 额度统计（切流后 Node 只做形状适配，数据全部来自 Go）。
  'getAccountQuotaStats',
  // 账号额度重置历史只读模型：数据源仍是 Node 的 app-state.db。
  'getAccountQuotaResetEvents',
  // 别名自动选号池只读设置（写入口仍在 Node）。
  'getAccountAliasPool',
  // 宿主机入口可用性探测：数据面已迁 Go，Node 只补静态能力与运行中实例。
  'getAppEntries',
  // 认证来源链：形状与判定由 Go 装配，Node 只做形状校验与插件来源兜底。
  'getProviderAuthSources',
  // SSH 连接/工作区/终端状态：只读投影已切 Go，Node 只做管理密钥后的转发。
  // 之前手写门面漏了这三项，SSH 路由运行期会拿到 undefined 并静默 503。
  'getSshConnections',
  'getSshWorkspaces',
  'getSshWorkspaceSessions',
  // 账号 token 用量（day/week/month/total + 分模型）。调试对拍入口用它取 Go 原始结果。
  'getAccountTokenUsage',
  // 历史用量导入（Node 中转，Go 的 management key 只在这里）。
  'importUsageEvents',
  // 上游错误映射组导入与对拍读取（Node 中转，Go 的 management key 只在这里）。
  'createUpstreamMappingGroup',
  'listUpstreamMappingGroups',
  // 账号级上游错误规则导入与对拍读取（同一中转模式）。
  'listAccountUpstreamErrorRules',
  // Go 引用 → Node 引用：对拍脚本按 Node 侧账号看结果。
  'nodeAccountRefFor',
  // Node 引用 → Go 引用：OAuth reauth 的 target_account_ref 必须用 Go 侧的键。
  'goRefsByNodeRef',
  // 组 CRUD 切到 Go：单条读取、更新、删除与上面的创建/列表同一批门面方法。
  'getUpstreamMappingGroup',
  'updateUpstreamMappingGroup',
  'deleteUpstreamMappingGroup',
  // 账号级路由排除（自定义上游账号不进 Go 路由候选）。
  'setAccountRouting',
  'createModelAlias',
  'updateModelAlias',
  'deleteModelAlias',
  'setModelAliasEnabled',
  'replaceModelAliases',
  // 账号导入后的对账：webui-account-routes-import.js 会调用它。
  // 之前手写门面漏了这项，导入后的「立刻对账」一直是静默跳过的死路径。
  'reconcileAccounts',
  // 账号刷新：Go 承接执行（异步作业），Node 只保留 202 信封与 SSE 推进。
  // getRefreshJob 用于轮询 Go 的作业终态；三个方法必须成组出现，缺一个都会在装配期报错。
  'refreshAccountWebUI',
  'refreshAccountUsageWebUI',
  'getRefreshJob',

  // 2026-11-11：以下方法一直在路由里调用，却漏登门面清单——门面只暴露清单内的
  // 方法，于是这些接口无论 Go 是否健康都恒返回 503 go_core_unavailable
  // （真机：/v0/webui/server-config、账号模型上下文、账号配置文件全部 503）。
  // 新增代理路由时必须同时登记到这里，test/webui-go-proxy.test.js 会扫源码兜底。
  'clearAccountModelContext',
  'getAccountConfigFiles',
  'getAccountModelContext',
  'getChatPasteSettings',
  'getControlPlaneEndpoints',
  'getControlPlaneProfiles',
  'getProviderCliUpgrade',
  'getServerConfig',
  'getToolkitTargets',
  'getUsageConfig',
  'getWindowActivation',
  'removeControlPlaneProfile',
  'saveControlPlaneProfile',
  'saveWindowActivationConfig',
  'setAccountAliasPool',
  'setAccountModelContext',
  'setAccountModelContextBulk',
  'setActiveControlPlaneProfile',
  'setServerConfig',
  'setUsageConfig',
  'updateChatPasteSettings',
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
