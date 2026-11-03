'use strict';

/**
 * 终端生命周期计划入口：计划由终端插件按平台声明（plugin.lifecycle[platform]），
 * 平台文件（macos/windows/linux.js）只提供与具体终端无关的包管理器/官方安装助手。
 */
function buildClientTerminalLifecyclePlans(terminal, context = {}, dependencies = {}) {
  const lifecycle = terminal && terminal.lifecycle;
  const buildPlans = lifecycle && lifecycle[context.platform];
  return typeof buildPlans === 'function' ? (buildPlans(context, dependencies) || []) : [];
}

module.exports = {
  buildClientTerminalLifecyclePlans
};
