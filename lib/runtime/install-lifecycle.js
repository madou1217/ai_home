'use strict';

const INSTALL_LIFECYCLE_ACTIONS = Object.freeze(['install', 'update', 'uninstall']);

/**
 * @typedef {Object} InstallLifecycle
 * @property {(context: Object) => unknown} install 安装实现。
 * @property {(context: Object) => unknown} update 更新实现。
 * @property {(context: Object) => unknown} uninstall 卸载实现。
 */

/**
 * 统一安装生命周期的接口边界。每个独立实现都必须提供三个动作；
 * 新动作只能通过扩展接口增加，不能把平台/provider 分支散落到调用方。
 */
function defineInstallLifecycle(definition, label = 'install lifecycle') {
  if (!definition || typeof definition !== 'object') {
    throw new TypeError(`${label} must be an object`);
  }
  for (const action of INSTALL_LIFECYCLE_ACTIONS) {
    if (typeof definition[action] !== 'function') {
      throw new TypeError(`${label} must implement ${action}()`);
    }
  }
  // 保留实现声明的扩展成员，使新接口可以在不修改现有调用方的前提下
  // 叠加到生命周期之上；基础调用方只依赖下面三个稳定动作。
  return Object.freeze({ ...definition });
}

module.exports = {
  INSTALL_LIFECYCLE_ACTIONS,
  defineInstallLifecycle
};
