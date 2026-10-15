'use strict';

/**
 * 宿主可观察 provider 的**权威列表**（叶子模块，零依赖）。
 *
 * 为什么单独一个文件：这个集合有两个消费者，一个在上游、一个在下游，直接互相 require 会成环：
 *   - `lib/server/account-ref-store.js` 的删除墓碑：凡是「宿主登录态会被自动观察」的 provider，
 *     用户删掉账号后都必须留墓碑，否则后台轮询会把它悄悄登记回来。
 *   - `lib/account/host-account-sync/index.js` 的观察者注册表：声明当前接线的 provider 覆盖。
 * 放进叶子模块后两边都只依赖它，`test/host-account-sync-registry.test.js` 再断言
 * **注册表覆盖 ⊆ 墓碑列表**，堵住「新接一个 provider 却忘了补墓碑」这条历史 bug。
 */
// 刻意保持**零依赖**（见上）：这里不 require 家族名单，四支显式列出。
// 不会因此漏掉新成员——`host-account-sync/index.js` 的注册表已派生自
// codebuddy-family-layouts 的 FAMILY_PROVIDERS，新增成员会自动进注册表，
// 而 test/host-account-sync-registry.test.js 断言「注册表覆盖 ⊆ 墓碑列表」，
// 所以「加了成员却忘了补墓碑」会在测试里失败，而不是线上被轮询登记回来。
const HOST_OBSERVED_PROVIDERS = Object.freeze([
  'codex',
  'codebuddy',
  'codebuddycn',
  'workbuddy',
  'workbuddycn',
  'cline'
]);

function isHostObservedProvider(provider) {
  return HOST_OBSERVED_PROVIDERS.includes(String(provider || '').trim().toLowerCase());
}

module.exports = { HOST_OBSERVED_PROVIDERS, isHostObservedProvider };
