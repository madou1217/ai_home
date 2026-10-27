'use strict';

const { createCodexNativeCredentialSync } = require('../codex-native-credential-sync');
const { createCodebuddyNativeCredentialSync } = require('../codebuddy-credential-sync');
const { createClineNativeCredentialSync } = require('../cline-native-credential-sync');
const { FAMILY_PROVIDERS } = require('../../runtime/codebuddy-family-layouts');
const { createGenericHostAccountSync, genericHostAccountSyncProviders } = require('./generic-host-account-sync');
const { createZcodeProjectionIdentitySync } = require('../zcode-projection-identity-sync');

/**
 * 宿主登录态观察者注册表 —— 「哪些 provider 的宿主登录会被自动发现并入库」的唯一接线点。
 *
 * 加一个 provider 只需要在 `HOST_ACCOUNT_SYNCS` 里加一行（实现 BaseHostAccountSync 的子类），
 * daemon 的启动/停止/统计/强制扫描四处循环都从这张表派生，不再各写一遍。同时必须把该
 * provider 补进 `../host-observed-providers.js` 的墓碑列表，否则用户删掉的账号会被轮询
 * 登记回来 —— `test/host-account-sync-registry.test.js` 用「注册表覆盖 ⊆ 墓碑列表」守住这条。
 *
 * 契约：每个 entry 的 `create(deps)` 返回一个同步器实例，提供 scan / start / stop / getStats
 * （见 base-host-account-sync.js）。`statsKey` 是它在 daemon getStats() 里的历史字段名。
 */
const HOST_ACCOUNT_SYNCS = Object.freeze([
  Object.freeze({
    id: 'codex',
    statsKey: 'nativeCredentialSync',
    providers: Object.freeze(['codex']),
    create: createCodexNativeCredentialSync
  }),
  Object.freeze({
    id: 'codebuddy-family',
    statsKey: 'codebuddyCredentialSync',
    providers: FAMILY_PROVIDERS,
    create: createCodebuddyNativeCredentialSync
  }),
  Object.freeze({
    id: 'cline',
    statsKey: 'clineCredentialSync',
    providers: Object.freeze(['cline']),
    create: createClineNativeCredentialSync
  }),
  // 通用观察者：覆盖面来自注册表倒排（认证来源 scan 钩子 + 凭据端口 hostApiKeySlots），只新增账号。
  Object.freeze({
    id: 'host-generic',
    statsKey: 'genericHostAccountSync',
    get providers() { return genericHostAccountSyncProviders(); },
    create: createGenericHostAccountSync
  }),
  // zcode 的**投影身份漂移**收敛：桌面端在账号沙箱里登录成另一个身份时，把新身份登记成
  // 独立账号、把登录态搬到它名下、并清掉旧账号里被采用的外来凭据（见
  // lib/account/zcode-projection-identity-sync.js 的模块说明）。
  Object.freeze({
    id: 'zcode-projection-identity',
    statsKey: 'zcodeProjectionIdentitySync',
    providers: Object.freeze(['zcode']),
    create: createZcodeProjectionIdentitySync
  })
]);

/**
 * 注册表覆盖的 provider 全集（用于与墓碑列表做覆盖断言）。惰性求值：通用 entry 的覆盖面来自
 * provider 注册表，不能在 require 时就把注册表拉起来。
 */
function listHostAccountSyncProviders() {
  return [...new Set(HOST_ACCOUNT_SYNCS.flatMap(entry => entry.providers))];
}

/** 按注册表建实例：`[{ id, statsKey, providers, sync }]`。 */
function createHostAccountSyncs(deps = {}) {
  return HOST_ACCOUNT_SYNCS.map(entry => ({
    id: entry.id,
    statsKey: entry.statsKey,
    providers: entry.providers,
    create: entry.create,
    sync: entry.create(deps)
  }));
}

module.exports = {
  HOST_ACCOUNT_SYNCS,
  get HOST_ACCOUNT_SYNC_PROVIDERS() { return Object.freeze(listHostAccountSyncProviders()); },
  createHostAccountSyncs,
  listHostAccountSyncProviders
};
