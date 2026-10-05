'use strict';

const codexPlugin = require('./codex');
const claudePlugin = require('./claude');
const opencodePlugin = require('./opencode');

/**
 * Provider CLI 自动升级插件注册表：每个 provider 私有的升级知识都在自己的插件里，
 * 流水线（渠道判定、静默闸门、校验）只读这张表，不再按 provider 名分支。
 * 没注册的 provider 走通用路径：npm/homebrew 渠道、只看 PTY 常驻会话、同一性断言兜底。
 *
 * 插件契约（与 contracts/plugins 的 contributes 字段对齐：id / capability）：
 * - id / capability='provider-cli.upgrade'
 * - standaloneRoots({ home, localAppData, path })?       → 官方 standalone 安装根（候选，未必存在）
 * - vendorSelfUpdateRoots({ home, localAppData, path })? → 自带更新器的安装根，aih 不接管
 * - collectBusyEvidence(options)?                         → 额外的「正在运行」证据
 * - strongVerifier(context)?                              → 装完后的强判据
 */
const PROVIDER_UPGRADE_PLUGINS = Object.freeze([codexPlugin, claudePlugin, opencodePlugin]);

const PLUGIN_BY_ID = new Map(PROVIDER_UPGRADE_PLUGINS.map((plugin) => [plugin.id, plugin]));

function getProviderUpgradePlugin(provider) {
  return PLUGIN_BY_ID.get(String(provider || '').trim().toLowerCase()) || null;
}

// 按注册顺序汇总所有插件声明的某类安装根候选。
function collectInstallRootCandidates(kind, context) {
  return PROVIDER_UPGRADE_PLUGINS.flatMap((plugin) => (
    typeof plugin[kind] === 'function' ? plugin[kind](context) : []
  ));
}

function strongVerifierFor(provider) {
  const verifier = getProviderUpgradePlugin(provider)?.strongVerifier;
  return typeof verifier === 'function' ? verifier : null;
}

module.exports = {
  PROVIDER_UPGRADE_PLUGINS,
  collectInstallRootCandidates,
  getProviderUpgradePlugin,
  strongVerifierFor
};
