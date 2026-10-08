'use strict';

// G5：已划给 Go 的路由在什么原因下仍由 Node 承接。
//
// 用途：Node 下线前必须能回答「现在还有多少请求真的只能由 Node 服务」，以及各自的原因。
// 只看总量是不够的——「Go 没就绪」和「模型只有 Node 支持」对下线决策的含义完全相反。
//
// 计数只活在进程内存里、随 Node 重启清零：它衡量的是当前运行态，不是历史账本。
// 只记原因名与次数，不记请求体、账号或 requestId（/readyz 是无鉴权的公开读端点）。

// 原因名是稳定合同：运维脚本与 Fabric 诊断按它聚合，改名等于改接口。
//
// 转发前判定（Node 决定不交给 Go）：
//   node_blob                  blob 只存在于生成它的进程内仓，Node 仓里有就由 Node 返回
//   pinned_account_unusable    钉选账号不可用/格式非法/未知，Node 负责回落常池或 403/404
//   pinned_account_unmapped    钉选头里是 Node 账号 id，没有 Node→Go 映射
//   pinned_model_not_routable  钉选可用但 Go 路由不了该模型
//   fabric_gateway_online      Fabric 远端网关在线，按模型/Provider 路由只存在于 Node v1
//   model_alias                模型命中启用的 Node 别名（含运行时回落到其它 Provider）
//   model_not_routable         Go 账号库里没有该模型（只有 Node 承接的 Provider）
//   plugin_unsupported_entry   插件贡献项存在，但该入口/传输不由 Go 执行
//   plugin_unsupported_capability 插件使用了 Go 还不支持的能力
//   plugin_generation_unacked  插件当前代次尚未被 Go 确认
//   go_not_forwarding          Go 未就绪或首轮账号同步未完成
//   alias_table_unreadable     别名表读不出来，保守交还而不是冒险让 Go 丢掉别名语义
//
// 转发后交还（Go 侧或传输层决定）：
//   decode_rejected            Go 显式标记的解码拒收（尚未选号、未联系上游）
//   go_unavailable             连接根本没建立，Go 一个字节都没收到
//   plugin_generation_unconfirmed 转发器需要已确认代次，但没有缓冲体可交还
const NODE_FALLBACK_REASONS = Object.freeze([
  'node_blob',
  'pinned_account_unusable',
  'pinned_account_unmapped',
  'pinned_model_not_routable',
  'fabric_gateway_online',
  'model_alias',
  'model_not_routable',
  'plugin_unsupported_entry',
  'plugin_unsupported_capability',
  'plugin_generation_unacked',
  'go_not_forwarding',
  'alias_table_unreadable',
  'decode_rejected',
  'go_unavailable',
  'plugin_generation_unconfirmed'
]);

function createNodeFallbackCounters() {
  const counts = new Map();
  let total = 0;

  return {
    /** 记一次「Go 已接管的路由由 Node 承接」。未登记的原因名照记，新增原因不会静默丢失。 */
    record(reason) {
      const name = String(reason || '').trim() || 'unknown';
      counts.set(name, (counts.get(name) || 0) + 1);
      total += 1;
    },
    /** 固定输出全部已登记原因（含 0），运维不必区分「没有」与「没这个原因」。 */
    snapshot() {
      const byReason = {};
      for (const reason of NODE_FALLBACK_REASONS) byReason[reason] = 0;
      for (const [name, count] of counts) byReason[name] = count;
      return { total, by_reason: byReason };
    }
  };
}

module.exports = { NODE_FALLBACK_REASONS, createNodeFallbackCounters };
