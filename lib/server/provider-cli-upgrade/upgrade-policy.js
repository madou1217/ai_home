'use strict';

// Provider CLI 自动升级的「该不该升」纯决策层：无 IO、无定时器、无网络。
//
// 三条实测事实塑造了这里的规则（2026-09-14）：
//   1. `npm view <pkg> dist-tags` 里存在 `darwin-arm64: 0.154.0-darwin-arm64` 这类**平台 tag**，
//      取「版本号最大者」会选到平台专用构建。远端版本只认 `dist-tags.latest`，本模块也只接受
//      调用方已经解析好的 latest 字符串，绝不自己在候选集里挑最大。
//   2. 上游可能把预发布推上 latest（本机 codex 装的就是 0.154.0-alpha.3）。用户要的是稳定版，
//      所以带 prerelease 的 latest 一律不升，并把原因显式报出去，而不是静默忽略。
//   3. 0.149→0.154 那次事故的窗口，靠 soak（新版本发布后静置一段时间再跟进）就能避开，
//      这是全方案性价比最高的一道闸门。
//
// 决策与「能不能回滚」强耦合：没有可回退的基线就不许升级——升上去发现坏了却回不去，
// 比不升级更糟。该判断由调用方以 rollbackable 传入，本模块只负责拒绝。

const { compareVersions, normalizeVersion } = require('../../cli/services/toolkit/app-update-checker');

const DEFAULT_SOAK_MS = 48 * 60 * 60 * 1000;
// 连续拿不到发布时间的次数上限。超过后不再假装「还在 soak」，而是显式暴露 soak_unknown：
// 「没做事」和「没事可做」必须在状态面上长得不一样，否则功能会带着一块绿仪表盘静默自停。
const DEFAULT_SOAK_UNKNOWN_LIMIT = 5;

const DECISIONS = Object.freeze({
  UPGRADE: 'upgrade',
  SKIP: 'skip',
  INELIGIBLE: 'ineligible'
});

function normalizePositiveMs(value, fallback, min = 0) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min) return fallback;
  return Math.floor(number);
}

function normalizeUpgradePolicyConfig(config = {}) {
  return {
    soakMs: normalizePositiveMs(config.soakMs, DEFAULT_SOAK_MS, 0),
    soakUnknownLimit: normalizePositiveMs(config.soakUnknownLimit, DEFAULT_SOAK_UNKNOWN_LIMIT, 1)
  };
}

function decide(input = {}, config = {}) {
  const { soakMs, soakUnknownLimit } = normalizeUpgradePolicyConfig(config);
  const now = Number(input.now) || 0;
  const installedVersion = String(input.installedVersion || '').trim();
  const latestVersion = String(input.latestVersion || '').trim();
  const blocked = Array.isArray(input.blockedVersions) ? input.blockedVersions : [];

  const skip = (reason, extra) => ({ decision: DECISIONS.SKIP, targetVersion: '', reason, ...extra });
  const ineligible = (reason) => ({ decision: DECISIONS.INELIGIBLE, targetVersion: '', reason });

  // 用户钉死版本 = 一切自动动作停止，优先级高于其他所有规则。
  if (String(input.userPin || '').trim()) return ineligible('user_pinned');
  if (input.enabled === false) return ineligible('disabled');
  // 渠道无法钉版本安装就无法回滚，只能观察不能动手。
  if (input.pinnable === false) return ineligible('channel_not_pinnable');
  if (!installedVersion) return skip('installed_version_unknown');
  if (!latestVersion) return skip('latest_version_unknown');

  // 基线未验证过，或基线版本已经回不去了：没有安全网，不许起跳。
  if (input.baselineHealthy === false) return skip('baseline_unhealthy');
  if (input.knownGoodRollbackable === false) return skip('known_good_not_rollbackable');

  if (blocked.includes(latestVersion)) return skip('version_blocked');

  const parsedLatest = normalizeVersion(latestVersion);
  if (!parsedLatest) return skip('latest_version_unparsable');
  // 上游把预发布推上了 latest：用户明确要稳定版，不跟。
  if (parsedLatest.prerelease.length > 0) return skip('latest_is_prerelease');

  const comparison = compareVersions(latestVersion, installedVersion);
  if (comparison === null) return skip('version_compare_failed');
  // 本机比 latest 新（例如手动装了 alpha）→ 不降级，但也不算错。
  if (comparison <= 0) return skip('up_to_date');

  const publishedAt = Number(input.publishedAt) || 0;
  if (!publishedAt) {
    const unknownCount = Number(input.soakUnknownCount) || 0;
    return unknownCount >= soakUnknownLimit
      ? skip('soak_unknown', { targetVersion: latestVersion })
      : skip('soak_pending_unknown_publish_time', { targetVersion: latestVersion });
  }
  const soakedFor = now - publishedAt;
  if (soakedFor < soakMs) {
    return skip('soaking', {
      targetVersion: latestVersion,
      soakRemainingMs: Math.max(0, soakMs - soakedFor)
    });
  }

  return { decision: DECISIONS.UPGRADE, targetVersion: latestVersion, reason: 'upgrade_available' };
}

module.exports = {
  DECISIONS,
  DEFAULT_SOAK_MS,
  DEFAULT_SOAK_UNKNOWN_LIMIT,
  normalizeUpgradePolicyConfig,
  decide
};
