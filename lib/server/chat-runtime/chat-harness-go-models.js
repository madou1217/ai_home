'use strict';

// Chat harness 网关目录的 Go 读取源。
//
// 读 GET /v1/management/account-models（一次读全池，不做 N+1），只保留 Go 判定为
// effective 的模型行，并把 Go 的 account_ref 翻译回 Node ref —— 两侧在同步 rekey /
// 身份合并后可能不同，直接拿 Go ref 当 key 会让账号整块消失。
//
// 返回形状与 WebUI 快照的 byAccount 一致：{ byAccount: { [nodeRef]: [modelId] } }，
// 并附带本次目录的 generation / updatedAtMs 供调用方观察。
//
// 条件刷新：冷启动先整份拉取建立基线；之后每次先用 meta_only=1 取指纹，generation
// 未变且未过 TTL 时直接复用上次结果；指纹前进、回退、缺失或 TTL 到期才整份拉取。
// Go 重启导致 generation 回退时也会重拉。
//
// 失败语义（未装配 / 503 / 网络异常 / 超时 / 没有任何 effective 模型）一律返回 null：
// 调用方回落到今天的本地快照路径。这里不抛异常，避免把「Go 抖动」升级成
// 「composer 模型列表清空」。

const { createGoModelCatalogReader } = require('../go-model-catalog-reader');

const ACCOUNT_MODELS_PATH = '/v1/management/account-models';
// harness 读取处在请求热路径（prewarm / 每轮模型解析）。Go 管理客户端默认 30s
// 超时对聊天来说太长，必须自己兜一个短预算，读不到就回落快照。
const DEFAULT_TIMEOUT_MS = 2000;
// 即使 generation 没变，也最多 10 分钟整份刷新一次：指纹由「最大 updated_at_ms +
// 行数」组成，同一毫秒内换掉一个模型这类写入可能撞值；TTL 是最后的兜底。
const DEFAULT_REFRESH_TTL_MS = 10 * 60 * 1000;
// meta_only=1 只回指纹（空 data），不把整份账号模型表序列化回来。
const STAMP_QUERY = { metaOnly: true };

function normalizeRef(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

async function readWithTimeout(promise, timeoutMs) {
  if (!(timeoutMs > 0)) return promise;
  let timer = null;
  try {
    return await Promise.race([
      Promise.resolve(promise).catch(() => null),
      new Promise((resolve) => {
        // 不能 unref：没有其它句柄时（测试/冷启动）计时器被跳过会让 Promise
        // 永远悬着。这个计时器最多存活 timeoutMs，成功路径会在 finally 清掉。
        timer = setTimeout(() => resolve(null), timeoutMs);
      })
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

function createChatHarnessGoModelSource(deps = {}) {
  const readAccountModels = deps.readAccountModels;
  const resolveNodeRef = typeof deps.nodeAccountRefFor === 'function' ? deps.nodeAccountRefFor : null;
  const timeoutMs = Number(deps.timeoutMs) > 0 ? Number(deps.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const refreshTtlMs = Number(deps.refreshTtlMs) > 0 ? Number(deps.refreshTtlMs) : DEFAULT_REFRESH_TTL_MS;
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const reader = typeof readAccountModels === 'function'
    ? createGoModelCatalogReader({
        effectiveOnly: true,
        call: (_method, path) => readAccountModels(path)
      })
    : null;

  // 上一次成功整份拉取的结果与指纹。generation 相同且未过 TTL 时直接复用，
  // 不再把整份账号模型表序列化回来。
  let hasCatalog = false;
  let lastGeneration = null;
  let lastGenerationKnown = false;
  let lastUpdatedAtMs = 0;
  let lastRefreshAtMs = 0;
  // 缓存 Go ref 的原始投影而不是翻译后的 Node ref：Node↔Go 的 rekey/身份合并
  // 可能在 generation 不变的情况下发生，命中缓存时仍要按当前映射重新翻译。
  let cachedByAccount = null;
  // Go 行里的 account_ref → provider：Go 独有账号要靠它判定 provider。
  let cachedProviderByAccount = null;

  function translate(remote) {
    const byAccount = {};
    const providerByAccount = {};
    for (const [goRef, models] of Object.entries(remote.byAccount)) {
      // 空目录不是「有集合」：调用方要回落快照，而不是返回空列表。
      if (!Array.isArray(models) || models.length === 0) continue;
      const nodeRef = normalizeRef(resolveNodeRef ? resolveNodeRef(goRef) : '');
      // Go 独有账号没有 Node ref；不能丢，否则聊天目录比账号页少一整类账号。
      const key = nodeRef || normalizeRef(goRef);
      if (!key) continue;
      byAccount[key] = models.slice();
      const provider = remote.providerByAccount && remote.providerByAccount[goRef];
      if (provider) providerByAccount[key] = String(provider).trim().toLowerCase();
    }
    if (Object.keys(byAccount).length === 0) return null;
    return { byAccount, providerByAccount };
  }

  function buildResult() {
    if (!cachedByAccount) return null;
    const translated = translate({
      byAccount: cachedByAccount,
      providerByAccount: cachedProviderByAccount
    });
    if (!translated) return null;
    return {
      ...translated,
      generation: lastGeneration,
      updatedAtMs: lastUpdatedAtMs
    };
  }

  return async function readGatewayModels() {
    if (!reader) return null;
    // 冷启动没有可比对的 generation，直接整份拉取建立基线；之后每次只先取指纹
    // （meta_only=1 返回空 data），相同且未过 TTL 时复用上次结果。
    let stamp = null;
    if (hasCatalog) {
      stamp = await readWithTimeout(reader.read(STAMP_QUERY), timeoutMs);
      if (!stamp) return null;
      const stampGenerationKnown = stamp.generationKnown === true;
      const stampGeneration = stampGenerationKnown ? (Number(stamp.generation) || 0) : null;
      const ttlExpired = now() - lastRefreshAtMs >= refreshTtlMs;
      // generation 未知（旧 Go / 响应缺字段）时不能用「相同」判断，必须整份拉取，
      // 否则升级前的 Go 会让 harness 永远停在旧目录上。
      // !== 同时覆盖前进和回退：Go 重启、库被恢复或行被级联删除都可能让指纹变小。
      const generationChanged = !stampGenerationKnown
        || !lastGenerationKnown
        || stampGeneration !== lastGeneration;
      if (!ttlExpired && !generationChanged) {
        return buildResult();
      }
    }
    const remote = await readWithTimeout(reader.read({}), timeoutMs);
    if (!remote || !remote.byAccount) return null;
    const stampHasGeneration = Boolean(stamp && stamp.generationKnown === true);
    if (remote.generationKnown === true) {
      lastGeneration = Number(remote.generation) || 0;
      lastGenerationKnown = true;
    } else if (stampHasGeneration) {
      // 全量响应没带指纹（极端旧版本）时，至少把探测到的指纹记下来，
      // 下一轮仍能靠它判断是否变化。
      lastGeneration = Number(stamp.generation) || 0;
      lastGenerationKnown = true;
    } else {
      lastGeneration = null;
      lastGenerationKnown = false;
    }
    lastUpdatedAtMs = Number(remote.updatedAtMs) || Number(stamp && stamp.updatedAtMs) || 0;
    lastRefreshAtMs = now();
    hasCatalog = true;
    cachedByAccount = remote.byAccount;
    cachedProviderByAccount = remote.providerByAccount || null;
    return buildResult();
  };
}

module.exports = {
  ACCOUNT_MODELS_PATH,
  DEFAULT_REFRESH_TTL_MS,
  createChatHarnessGoModelSource,
  __private: { readWithTimeout }
};
