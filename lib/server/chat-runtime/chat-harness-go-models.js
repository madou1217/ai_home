'use strict';

// Chat harness 网关目录的 Go 读取源。
//
// 读 GET /v1/management/account-models（一次读全池，不做 N+1），只保留 Go 判定为
// effective 的模型行，并把 Go 的 account_ref 翻译回 Node ref —— 两侧在同步 rekey /
// 身份合并后可能不同，直接拿 Go ref 当 key 会让账号整块消失。
//
// 返回形状与 WebUI 快照的 byAccount 一致：{ byAccount: { [nodeRef]: [modelId] } }。
//
// 失败语义（未装配 / 503 / 网络异常 / 超时 / 没有任何 effective 模型）一律返回 null：
// 调用方回落到今天的本地快照路径。这里不抛异常，避免把「Go 抖动」升级成
// 「composer 模型列表清空」。

const { createGoModelCatalogReader } = require('../go-model-catalog-reader');

const ACCOUNT_MODELS_PATH = '/v1/management/account-models';
// harness 读取处在请求热路径（prewarm / 每轮模型解析）。Go 管理客户端默认 30s
// 超时对聊天来说太长，必须自己兜一个短预算，读不到就回落快照。
const DEFAULT_TIMEOUT_MS = 2000;

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

  return async function readGatewayModels() {
    if (typeof readAccountModels !== 'function') return null;
    const reader = createGoModelCatalogReader({
      effectiveOnly: true,
      call: (_method, path) => readAccountModels(path)
    });
    const remote = await readWithTimeout(reader.read({}), timeoutMs);
    if (!remote || !remote.byAccount) return null;
    const byAccount = {};
    for (const [goRef, models] of Object.entries(remote.byAccount)) {
      // 空目录不是「有集合」：调用方要回落快照，而不是返回空列表。
      if (!Array.isArray(models) || models.length === 0) continue;
      const nodeRef = normalizeRef(resolveNodeRef ? resolveNodeRef(goRef) : goRef);
      if (!nodeRef) continue;
      byAccount[nodeRef] = models.slice();
    }
    return Object.keys(byAccount).length > 0 ? { byAccount } : null;
  };
}

module.exports = {
  ACCOUNT_MODELS_PATH,
  createChatHarnessGoModelSource,
  __private: { readWithTimeout }
};
