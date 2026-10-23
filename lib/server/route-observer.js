'use strict';

// 路由观测的**写入侧装配**：把「本次请求落到了哪个账号」落盘，供网关模式的终端标题读回。
//
// 为什么需要工厂：`runWithAccountAttempts` 有两个调用点（通用上游 `upstream-endpoints`
// 与 codex 的 `/v1/responses` `codex-adapter`），两侧都必须挂同一个回调。把构造收敛在
// 这里，新增第三个调用点时不必再抄一遍（DRY），也保证两侧写出的观测值形状一致。
//
// 只写**寻址元数据**（账号引用 / 显示序号 / 模型 / 时间），绝不写凭据——这个目录会被
// CLI 进程与诊断工具读到。没有会话键就不写：观测值无法关联回某个 CLI 会话，写下来
// 也没人读，只会留下垃圾文件。

const { writeRouteObservation } = require('../runtime/route-observation');
const { resolveAiHomeDir } = require('../runtime/aih-home');
const { resolveCliAccountRef } = require('./account-ref-store');

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

// 返回一个 `({ accountRef, account, model }) => void` 回调；永不抛（观测失败不该影响请求）。
//
// aiHomeDir 的取值刻意宽松：两个调用点的 deps 白名单各自不同（codex 的
// `handleCodexChatCompletions` 并不传 fs/aiHomeDir），而观测只是诊断面——为了它去
// 改两处白名单是本末倒置，所以拿不到时回退到环境/宝宝屋规则自己解析。
function createRouteObserver(deps = {}) {
  const requestMeta = deps.requestMeta || {};
  return ({ accountRef, account, model } = {}) => {
    try {
      const sessionKey = normalizeText(requestMeta.sessionKey);
      const ref = normalizeText(accountRef);
      if (!sessionKey || !ref) return;
      const aiHomeDir = resolveAiHomeDir({ aiHomeDir: deps.aiHomeDir });
      writeRouteObservation({
        fs: deps.fs,
        aiHomeDir,
        sessionKey,
        accountRef: ref,
        // 标题里要显示的是**用户认得的账号序号**（与 `aih ls` / 账号页同口径），
        // 不是 provider 内部 id。运行池里的账号对象并不总带 cliAccountId，
        // 所以拿不到时按 accountRef 反查一次（同一个 SQLite 连接，开销可控）。
        accountId: normalizeText(account && account.cliAccountId)
          || normalizeText(readCliAccountId(aiHomeDir, ref, deps)),
        model: normalizeText(model)
      });
    } catch (_error) {
      // 观测是诊断面：任何失败都吞掉，绝不影响请求本身。
    }
  };
}

// accountRef → 展示用账号序号。fail-soft：查不到就返回空串，标题退化成只显示模型。
function readCliAccountId(aiHomeDir, accountRef, deps = {}) {
  try {
    const record = resolveCliAccountRef(deps.fs, aiHomeDir, accountRef, { bestEffort: true });
    return normalizeText(record && record.cliAccountId);
  } catch (_error) {
    return '';
  }
}

module.exports = { createRouteObserver };
