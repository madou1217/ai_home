'use strict';

// WebUI / 管理接口编辑后的 Go Core 投影「即时同步」。
//
// 别名与错误规则的权威都在 Go；本模块只让宿主在编辑后立即回读 Go 的投影报告，
// 让 /readyz 与状态接口展示的 generation / accepted 计数不会滞后一个定时器周期。
// 它不参与请求路由判定：推理入口全部由 Go 承接，Go 的路由目录就是最终结果。
//
// 装配缺失（旧宿主、测试替身、Go 未启用）时安静跳过，绝不抛出——编辑已经落盘，
// 兜底定时器会补上。

/** 投影名 → go-core-host 上对应的推送方法。 */
const PROJECTION_METHODS = Object.freeze({
  modelAliases: 'pushModelAliases',
  upstreamErrorRules: 'pushUpstreamErrorRules'
});

/** 从路由 ctx 里取 Go Core 同步入口（宿主注入的 deps，或缺省为空）。 */
function resolveGoCoreSync(ctx) {
  if (!ctx) return null;
  if (ctx.goCoreSync) return ctx.goCoreSync;
  return ctx.deps && ctx.deps.goCoreSync || null;
}

/**
 * 触发一次投影推送，best-effort 且不阻塞响应。
 *
 * 返回 Promise<boolean>：是否真的发起了推送（用于测试与可观测性）。
 */
function notifyGoCoreProjection(ctx, projection) {
  const host = resolveGoCoreSync(ctx);
  const method = PROJECTION_METHODS[projection];
  if (!host || !method || typeof host[method] !== 'function') return Promise.resolve(false);
  return Promise.resolve()
    .then(() => host[method]())
    .then(() => true)
    .catch(() => false);
}

module.exports = {
  PROJECTION_METHODS,
  notifyGoCoreProjection,
  resolveGoCoreSync
};
