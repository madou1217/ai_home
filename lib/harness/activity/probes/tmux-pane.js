'use strict';

// 通用探测器：aih 启动的持久会话（tmux/psmux pane）最后一次有输出的时刻。
//
// 这是「通过 aih 启动」这一层能做出的文章：所有 harness（原生 CLI、外部 harness
// pi/dsh、以及未来的新 CLI）都由 aih 包在持久终端里，pane 输出与模型推理同步——
// 模型答题时 TUI 必然持续重绘，静默只可能是等用户输入或回合已结束。
//
// 权威性按 harness 的会话同步合同决定（context.turnMode）：
//   * 'hook'       —— 官方 hook 事件是回合的权威来源；pane 只能「看到输出 → 一定在跑」
//                     （positive），熄灯交给 markSessionTurn/endSessionTurn 的 hook 路由；
//   * 其余（'polling'/'unavailable'/'external'）—— 没有更好的信号，pane 静默即空闲，
//                     可以熄灯（authority='turn'）。
//
// 探测不到活动时间（旧版 tmux 或字段缺失，值 0）时返回 null，不猜「空闲」。
module.exports = {
  id: 'tmux-pane',
  label: '持久终端 pane 活动',
  priority: 0,
  claims: () => true,
  probe(context) {
    const sessions = Array.isArray(context.sessions) ? context.sessions : [];
    const activityAtList = sessions
      .map((session) => Number(session && session.lastActivityAt) || 0)
      .filter((value) => value > 0);
    if (activityAtList.length === 0) return null;
    const lastActivityAt = Math.max(...activityAtList);
    const active = context.nowMs - lastActivityAt <= context.turnActiveWindowMs;
    const authority = context.turnMode === 'hook' ? 'positive' : 'turn';
    return {
      turn: active ? true : (authority === 'turn' ? false : null),
      authority,
      decisive: false,
      lastActivityAt,
      source: 'tmux-pane'
    };
  }
};
