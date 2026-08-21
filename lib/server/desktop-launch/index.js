'use strict';

const { defaultDesktopLaunchStrategy } = require('./default-strategy');
const { zcodeDesktopLaunchStrategy } = require('./zcode-strategy');
const { agyDesktopLaunchStrategy } = require('./agy-strategy');
const { kimiDesktopLaunchStrategy } = require('./kimi-strategy');

/**
 * Desktop 启动策略注册表。
 *
 * 账号应用启动器只依赖 getDesktopLaunchStrategy 这一个入口，永远不按 provider
 * 名分支；新增或修改某个 provider 的桌面启动细节 = 改它自己的策略 + 这张表
 * （Open/Closed），启动器保持不动。未注册的 provider 走中性默认实现。
 *
 * @type {Object<string, import('./default-strategy').DesktopLaunchStrategy>}
 */
const STRATEGY_BY_PROVIDER = {
  zcode: zcodeDesktopLaunchStrategy,
  agy: agyDesktopLaunchStrategy,
  kimi: kimiDesktopLaunchStrategy
};

function getDesktopLaunchStrategy(provider) {
  return STRATEGY_BY_PROVIDER[String(provider || '').trim().toLowerCase()]
    || defaultDesktopLaunchStrategy;
}

// resolveDesktopInstanceName 供进程匹配层按 provider 取账号的单实例身份，
// 让 launcher / WebUI 运行态映射共用同一份派生规则。
function resolveDesktopInstanceName(provider, accountRef) {
  return getDesktopLaunchStrategy(provider).resolveInstanceName({ accountRef });
}

// parseDesktopInstance 从任意桌面主进程命令行反解出实例身份：进程扫描无法预知
// 进程属于哪个 provider，因此按注册表逐个询问，未改写命令行的 provider 认领为空。
//
// 只有恰好一个 provider 认领时才算解析成功。多家同时认领说明身份规则撞车，
// 此时宁可返回空、让上层回落到 --user-data-dir 判重，也绝不按注册顺序猜：
// 猜错会把实例归到别的账号，运行态显示错位，close 更会杀掉别人的进程。
function parseDesktopInstance(commandLine) {
  const claims = [];
  for (const [provider, strategy] of Object.entries(STRATEGY_BY_PROVIDER)) {
    const name = String(strategy.parseInstanceName(commandLine) || '').trim();
    if (name) claims.push({ provider, name });
  }
  return claims.length === 1 ? claims[0] : null;
}

function parseDesktopInstanceName(commandLine) {
  const claim = parseDesktopInstance(commandLine);
  return claim ? claim.name : '';
}

module.exports = {
  STRATEGY_BY_PROVIDER: Object.freeze(STRATEGY_BY_PROVIDER),
  getDesktopLaunchStrategy,
  parseDesktopInstance,
  parseDesktopInstanceName,
  resolveDesktopInstanceName
};
