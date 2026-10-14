'use strict';

// 原生额度源的登记表 —— 数据，不是行为。
//
// 只声明「谁有原生额度、快照 kind / source / shape 是什么」这三件事实；具体探针实现仍在
// 各自的原生模块里（codex/claude/agy/gemini 的刷新阶梯在 usage/snapshot.js，kimi / grok /
// kiro / zcode / CodeBuddy 家族是 `*-quota-probe.js`）。注册表把这些事实和插件登记的事实
// 合并成同一个视图，消费方（可信快照校验、定时探测、账号页）只问注册表。
//
// source 取值与 `lib/cli/config/constants.js` / `lib/server/accounts.js` 的常量一致；
// 调用方可用 usageSources 覆盖（app 装配时会传入同一批常量），避免出现第二份事实。

const { USAGE_SNAPSHOT_KINDS, USAGE_SOURCE_KIMI, USAGE_SOURCE_GROK, USAGE_SOURCE_KIRO, USAGE_SOURCE_ZCODE, USAGE_SOURCE_CODEBUDDY } = require('../../account/usage-remaining');
const { CODEBUDDY_FAMILY_PROVIDERS } = require('../../account/codebuddy-billing');

const NATIVE_USAGE_SOURCES = Object.freeze({
  gemini: 'gemini_refresh_user_quota',
  codex: 'codex_app_server',
  agyCodeAssist: 'agy_fetch_available_models',
  claudeOauth: 'claude_oauth_usage_api',
  claudeAuthToken: 'claude_auth_token_usage_api'
});

/**
 * @param {object} [usageSources] 调用方装配时的 source 常量（缺省用本模块的规范值）
 * @returns {Array<object>} 可直接交给 createQuotaProviderRegistry({ nativeSources }) 的声明
 */
function buildNativeQuotaSources(usageSources = {}) {
  const claudeSources = [
    usageSources.claudeOauth || NATIVE_USAGE_SOURCES.claudeOauth,
    usageSources.claudeAuthToken || NATIVE_USAGE_SOURCES.claudeAuthToken
  ];
  const codebuddySource = { shape: 'entries' };
  return [
    {
      id: 'gemini',
      providers: ['gemini'],
      snapshotKind: 'gemini_oauth_stats',
      sources: [usageSources.gemini || NATIVE_USAGE_SOURCES.gemini],
      entryShape: 'models'
    },
    {
      id: 'codex',
      providers: ['codex'],
      snapshotKind: 'codex_oauth_status',
      sources: [usageSources.codex || NATIVE_USAGE_SOURCES.codex],
      entryShape: 'window'
    },
    {
      id: 'claude',
      providers: ['claude'],
      snapshotKind: 'claude_oauth_usage',
      sources: claudeSources,
      entryShape: 'window'
    },
    {
      id: 'agy',
      providers: ['agy'],
      snapshotKind: 'agy_code_assist_quota',
      sources: [usageSources.agyCodeAssist || NATIVE_USAGE_SOURCES.agyCodeAssist],
      shape: 'models',
      entryShape: 'models'
    },
    { id: 'kimi', providers: ['kimi'], snapshotKind: USAGE_SNAPSHOT_KINDS.kimi, sources: [USAGE_SOURCE_KIMI], shape: 'entries', entryShape: 'window' },
    // grok / kiro / zcode 的条目是余额桶（bucket: 'credits' 等），展示走 credits 口径，
    // 不是「5h / 7days」时间窗。
    { id: 'grok', providers: ['grok'], snapshotKind: USAGE_SNAPSHOT_KINDS.grok, sources: [USAGE_SOURCE_GROK], shape: 'entries', entryShape: 'bucket' },
    { id: 'kiro', providers: ['kiro'], snapshotKind: USAGE_SNAPSHOT_KINDS.kiro, sources: [USAGE_SOURCE_KIRO], shape: 'entries', entryShape: 'bucket' },
    { id: 'zcode', providers: ['zcode'], snapshotKind: USAGE_SNAPSHOT_KINDS.zcode, sources: [USAGE_SOURCE_ZCODE], shape: 'entries', entryShape: 'bucket' },
    // 家族四支共用同一 kind / source（同地区 work/code 是同一账号、同一余额接口）。
    {
      id: 'codebuddy-family',
      providers: [...CODEBUDDY_FAMILY_PROVIDERS],
      snapshotKind: USAGE_SNAPSHOT_KINDS.codebuddy,
      sources: [USAGE_SOURCE_CODEBUDDY],
      shape: codebuddySource.shape,
      entryShape: 'bucket'
    }
  ];
}

module.exports = {
  NATIVE_USAGE_SOURCES,
  buildNativeQuotaSources
};
