'use strict';

// 「Go 能承接哪些带出口绑定的账号」的判定（转发前用）。
//
// 背景：推理入口划给 Go 后，账号级出口仍只有 Node 会执行。provider 的 direct 绑定
// （显式直连）在 **Go 没有全局代理** 时与 Go 的行为完全一致——此时再交还 Node 只会
// 让 relay 永远轮不到 Go（本机 zcode/qoder 账号全部绑 direct，实测 account_egress
// 把每次转发都挡回去）。有全局代理时仍必须交还，否则会绕过用户要求的直连。
//
// 为什么单独成模块：既有的 account-egress-binding-index 缓存的是「必须交还 Node」的
// 静态集合，direct 是否在其中取决于 Go 的运行时配置，不能复用同一份缓存。

const {
  EGRESS_MODE_DIRECT,
  EGRESS_MODE_POOL,
  EGRESS_MODE_SYSTEM,
  EGRESS_MODE_URL,
  listAccountEgressBindings
} = require('../account/zcode-egress-binding-store');

// 网关侧会改写出站的模式：Go 没有账号级出口，必须交还 Node。
const GO_UNSUPPORTED_MODES = new Set([EGRESS_MODE_URL, EGRESS_MODE_POOL, EGRESS_MODE_SYSTEM]);

/**
 * 判定一条绑定是否要求 Node 承接。
 *
 * @param {object} binding 绑定记录
 * @param {boolean} goHasGlobalProxy Go 进程是否有全局代理
 */
function bindingRequiresNode(binding, goHasGlobalProxy) {
  if (!binding) return false;
  if (binding.retired) return true;
  if (binding.mode === EGRESS_MODE_DIRECT) return goHasGlobalProxy === true;
  return GO_UNSUPPORTED_MODES.has(binding.mode);
}

/**
 * 读取绑定表并返回必须由 Node 承接的账号集合；读不出来返回 null（调用方按保守处理）。
 */
function listNodeBoundRefs(options = {}) {
  const fs = options.fs || require('node:fs');
  const aiHomeDir = String(options.aiHomeDir || '').trim();
  const goHasGlobalProxy = options.goHasGlobalProxy === true;
  const list = typeof options.listBindings === 'function' ? options.listBindings : listAccountEgressBindings;
  try {
    const entries = aiHomeDir ? list(fs, aiHomeDir) : [];
    return new Set(
      entries
        .filter((entry) => bindingRequiresNode(entry.binding, goHasGlobalProxy))
        .map((entry) => entry.accountRef)
    );
  } catch (_error) {
    return null;
  }
}

module.exports = { bindingRequiresNode, listNodeBoundRefs };
