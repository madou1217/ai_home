'use strict';

// WebUI / 管理接口编辑后的 Go Core 投影「即时同步」。
//
// go-core-host 里的定时器只是兜底（别名表、规则表定期重推）。但规则表不即时推送的
// 代价不是「晚一点生效」而是**结论错误**：`go-core-route-deferral` 用「Go 是否已承接该
// 账号」决定请求交给谁，而接受集合只由一次成功的推送更新。保存规则后若不立刻推送，
// 最长一个刷新周期内 Go 侧仍是旧规则表，那段时间新规则静默不生效。
//
// 因此把「编辑 → 推送」收敛到这一处：调用方只声明推哪一份投影，装配缺失（旧宿主、
// 测试替身、Go 未启用）时安静跳过，绝不抛出——编辑已经落盘，兜底定时器会补上。

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
