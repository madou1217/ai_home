'use strict';

const { createCodexNativeCredentialSync } = require('../codex-native-credential-sync');
const { createCodebuddyNativeCredentialSync } = require('../codebuddy-credential-sync');
const { createClineNativeCredentialSync } = require('../cline-native-credential-sync');

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
    providers: Object.freeze(['codebuddy', 'codebuddycn', 'workbuddy', 'workbuddycn']),
    create: createCodebuddyNativeCredentialSync
  }),
  Object.freeze({
    id: 'cline',
    statsKey: 'clineCredentialSync',
    providers: Object.freeze(['cline']),
    create: createClineNativeCredentialSync
  })
]);

/** 注册表覆盖的 provider 全集（用于与墓碑列表做覆盖断言）。 */
const HOST_ACCOUNT_SYNC_PROVIDERS = Object.freeze([
  ...new Set(HOST_ACCOUNT_SYNCS.flatMap(entry => entry.providers))
]);

/** 按注册表建实例：`[{ id, statsKey, providers, sync }]`。 */
function createHostAccountSyncs(deps = {}) {
  return HOST_ACCOUNT_SYNCS.map(entry => ({ ...entry, sync: entry.create(deps) }));
}

module.exports = { HOST_ACCOUNT_SYNCS, HOST_ACCOUNT_SYNC_PROVIDERS, createHostAccountSyncs };
