'use strict';

// npm 发布时间表的进程内缓存，键是 (包名, 最新版本)。
//
// 为什么能缓存：time 表只在有新版本发布时才变，而新版本发布会先体现在
// `npm view <pkg> version` 的结果上——那条查询每轮照跑。所以「最新版本没变」就复用
// 上次的整张表；最新版本一变立刻失效重拉，新版本发布后 10 分钟内开始升级的时效不受影响
// （见 provider-cli-upgrade-scheduler.js 的 5 分钟节奏）。
//
// TTL 兜底：同一条最新版本下也可能补发旧线的补丁版本，最多晚 MAX_AGE_MS 被看到，
// 与引入 5 分钟节奏之前「每 6h 拉一次」的代价一致。
//
// 同一个包被多个 provider 共用（codebuddy / codebuddycn 都是 @tencent-ai/codebuddy-code）时，
// 同一轮第二个 provider 直接命中，不再重复下载 250KB。
//
// 只缓存成功的结果：查询失败不写入，下一轮照常重试。

const MAX_AGE_MS = 6 * 60 * 60 * 1000;

function createReleaseTimeCache(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const maxAgeMs = Number(options.maxAgeMs) > 0 ? Number(options.maxAgeMs) : MAX_AGE_MS;
  const entries = new Map();

  function get(packageName, latestVersion) {
    const entry = entries.get(packageName);
    if (!entry || !latestVersion || entry.latestVersion !== latestVersion) return null;
    if (now() - entry.storedAt >= maxAgeMs) {
      entries.delete(packageName);
      return null;
    }
    return { releases: entry.releases, publishedAt: entry.publishedAt };
  }

  function set(packageName, latestVersion, value = {}) {
    if (!packageName || !latestVersion) return;
    entries.set(packageName, {
      latestVersion,
      releases: Array.isArray(value.releases) ? value.releases : [],
      publishedAt: Number(value.publishedAt) || 0,
      storedAt: now()
    });
  }

  return { get, set };
}

module.exports = {
  MAX_AGE_MS,
  createReleaseTimeCache
};
