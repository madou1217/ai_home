'use strict';

// 「哪些账号的网关请求必须经过账号出口」的进程内索引（Go Core 转发前判定用）。
//
// 为什么需要（2026-10-19 取证）：推理入口已划给 Go Core，而 Go 没有账号出口的概念 ——
// 账号绑定了代理地址 / 出口池 / 系统代理时，被 Go 承接的请求会绕过账号出口直连上游
// （泄漏真实出口 IP，也破坏地区策略）。在 Go 实现出口之前，这类账号的请求必须交还 Node。
//
// 需要交还的绑定 = 网关侧会改写出站的模式：url / pool / system，以及已下线（retired）的
// 旧记录（Node 对它 fail-closed，Go 不会）。tun 在网关侧是直连（noProxy:'*'），与 Go 行为一致，不交还。
//
// 转发判定在每个请求上运行，不能每次查库：结果缓存 TTL 秒，出口绑定写入时立即失效（invalidate）。

const nodeFs = require('node:fs');
const {
  EGRESS_MODE_DIRECT,
  EGRESS_MODE_POOL,
  EGRESS_MODE_SYSTEM,
  EGRESS_MODE_URL,
  listAccountEgressBindings
} = require('../account/zcode-egress-binding-store');

const DEFAULT_TTL_MS = 5000;
// 网关侧会改写出站的模式：Go Core 只从进程环境读代理（server config 的 proxy_url 由 Node
// 写进它的标准代理变量，见 go-core-proxy-guard），没有账号级出口的概念，所以这类账号的
// 请求必须交还 Node，否则会被 Go 的全局代理悄悄接管。
//
// 直连（direct）也在其中，理由与 url/pool/system 相反但同样致命：Go 会继续走它自己的全局
// 代理，而用户明确要求该账号绕过任何代理 —— 那是**出口泄漏**。tun 不在此列（网关侧它是
// 「直连」，与没有全局代理时的 Go 行为一致），direct 不能沿用这条豁免。
const GATEWAY_REWRITING_MODES = new Set([EGRESS_MODE_URL, EGRESS_MODE_POOL, EGRESS_MODE_SYSTEM, EGRESS_MODE_DIRECT]);

function requiresNodeEgress(binding) {
  if (!binding) return false;
  return Boolean(binding.retired) || GATEWAY_REWRITING_MODES.has(binding.mode);
}

function createAccountEgressBindingIndex(options = {}) {
  const fs = options.fs || nodeFs;
  const aiHomeDir = String(options.aiHomeDir || '').trim();
  const ttlMs = Number(options.ttlMs) > 0 ? Number(options.ttlMs) : DEFAULT_TTL_MS;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const list = typeof options.listBindings === 'function' ? options.listBindings : listAccountEgressBindings;
  let refs = null;
  let loadedAt = 0;

  function load() {
    if (refs && now() - loadedAt < ttlMs) return refs;
    let entries = [];
    try {
      entries = aiHomeDir ? list(fs, aiHomeDir) : [];
    } catch (_error) {
      // 读不出来时保守：视为「未知」，由调用方决定（转发判定按「有人绑定」交还 Node）。
      refs = null;
      loadedAt = now();
      return null;
    }
    refs = new Set(entries.filter((entry) => requiresNodeEgress(entry.binding)).map((entry) => entry.accountRef));
    loadedAt = now();
    return refs;
  }

  return {
    /** 需要经 Node 出口的账号集合；读不出来时返回 null。 */
    refs: load,
    /** 该账号是否必须经 Node 出口。读不出来时返回 true（保守）。 */
    requiresNode(accountRef) {
      const set = load();
      if (!set) return true;
      return set.has(String(accountRef || '').trim());
    },
    invalidate() {
      refs = null;
      loadedAt = 0;
    }
  };
}

module.exports = {
  createAccountEgressBindingIndex,
  requiresNodeEgress
};
