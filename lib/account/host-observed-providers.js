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
