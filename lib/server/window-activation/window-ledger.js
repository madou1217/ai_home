'use strict';

// 窗口账本（window ledger）：把用量快照翻成「当前有没有活跃窗口」，并维护一份
// 「锚点 / 关窗时刻」记录，让窗口激活调度器不必依赖快照新鲜度。
//
// 上游事实（2026-10-16 本机取证，详见 docs/plans/2026-10-16-window-activation-redesign.md）：
//   F1 窗口由「关闭后的第一个请求」锚定，reset = 锚点 + 窗口时长，秒级精确；
//   F2 窗口期内的请求不移动锚点 → 知道锚点就等于知道关窗时刻（确定值，不需要新鲜快照）；
//   F3 窗口关闭且无人使用时，快照报「读取时刻 + 窗口时长」（幻影值），与真实活跃窗口
//      形态完全一致 —— 只看「reset 是否在未来」永远区分不出真假；
//   F4 只有真实请求会开窗，纯只读（用量快照刷新）不会。
//
// 于是「怎么观察」只有一条判据：`|capturedAt - (resetAtMs - 窗口时长)| ≤ 容差` 就是幻影
// （读取时刻现算的 reset），否则就是真窗口。容差必须偏小且偏向「判成没有窗口」：
//   · 误判成 absent（没有活跃窗口）→ 多探一次（窗口开着时探测是空操作，无害）；
//   · 误判成 live（有活跃窗口）→ 错过一次续窗（窗口一直空着，有害）。
//
// 本文件是纯函数 + 纯数据：不读盘、不发请求、不碰账号状态、不含 provider 名。
// 「要不要探」在 window-activation-scheduler.js 的 decideActivation。

// 「锚点 ≈ 读取时刻」的容差。幻影的差值≈0（上游现算，与本地 capturedAt 秒级同步），
// 真窗口的差值至少是「上次开窗到现在」（分钟级）——90s 足以分开两者，同时容下
// 「探测成功 → 马上读一次快照」这条链路的网络/落盘延迟（靠 lastProbeAt 消歧）。
const PHANTOM_TOLERANCE_MS = 90 * 1000;
// 关窗时刻之后才探测：本地与上游时钟实测差 < 1s，留 1 分钟吸收时钟/网络抖动。
// （旧设计反过来「提前 5 分钟探测」，打进旧窗口白探且续不上新窗口。）
const PROBE_GRACE_MS = 60 * 1000;
// 失败重试退避下限：探测失败（尤其中断的是「窗口已关闭」这种急需补窗的时刻）下一轮
// 就应该重试，而不是等一整个兜底间隔。
const PROBE_RETRY_BACKOFF_MS = 10 * 60 * 1000;
// 「关窗后的活动是不是我们自己的探测」的判别余量：探测请求的 attempt 记账时刻与
// 我们记录的 lastProbeAt 相差在网络往返量级（本机 < 1s），留 15s 避免把自家探测
// 误当成用户流量。
const ACTIVITY_EPS_MS = 15 * 1000;

const MS_PER_MINUTE = 60 * 1000;
// 固定窗口 spec（agy）的 entry 归属判别余量：5h 窗口 entry 的 resetAtMs 与快照读取
// 时刻的差 ≤ 窗口时长（phantom 正好≈时长）；周窗口的差是天级，留 10 分钟吸收时钟抖动。
const FIXED_WINDOW_MATCH_SLACK_MS = 10 * MS_PER_MINUTE;
const MAX_PROBE_FAILURE_COUNT = 32;

function toMs(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.floor(number) : fallback;
}

function toPositiveMs(value, fallback = 0) {
  const normalized = toMs(value, fallback);
  return normalized > 0 ? normalized : fallback;
}

function listSnapshotEntries(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return [];
  if (Array.isArray(snapshot.entries)) return snapshot.entries;
  if (Array.isArray(snapshot.models)) return snapshot.models;
  return [];
}

/**
 * 能力识别：从快照里找出符合 spec.windowMatch 的窗口项。
 *
 * 三种识别方式：
 *   · `windowMinutes`（codex 等：entries[] 里直接带窗口分钟数）
 *   · 固定窗口 spec（agy，windowMode='fixed'）：entry 没有 windowMinutes，但有 resetAtMs。
 *     按「resetAtMs 与快照读取时刻的差 ≤ 声明窗口时长」识别 5h 组；周窗口的差是天级，
 *     即使同样带 5h 文案也不会被选中。
 *   · `resetIn` 标签（legacy/无 capturedAt 时的兜底）
 *
 * @param {object|null} snapshot
 * @param {object|null} windowMatch
 * @param {{windowMode?: string}} [options]
 * @returns {object|null}
 */
function findWindowEntry(snapshot, windowMatch, options = {}) {
  if (!windowMatch) return null;
  const target = Number(windowMatch.windowMinutes);
  const label = String(windowMatch.resetInLabel || '').trim().toLowerCase();
  const mode = String(options.windowMode || windowMatch.windowMode || '').trim().toLowerCase();
  const capturedAt = toMs(snapshot && snapshot.capturedAt, 0);
  const fixedWindowMs = Number.isFinite(target) && target > 0 ? target * MS_PER_MINUTE : 0;
  const fixedMode = mode === 'fixed' && fixedWindowMs > 0;
  if (!Number.isFinite(target) && !label && !fixedMode) return null;
  for (const entry of listSnapshotEntries(snapshot)) {
    if (!entry) continue;
    if (fixedMode && capturedAt > 0) {
      const resetAtMs = Number(entry.resetAtMs);
      if (Number.isFinite(resetAtMs) && resetAtMs > 0
        && resetAtMs - capturedAt <= fixedWindowMs + FIXED_WINDOW_MATCH_SLACK_MS) {
        return entry;
      }
      // 固定窗口模式只按差值识别：差值超过窗口时长的（周窗口）即使文案像 5h 也跳过。
      continue;
    }
    if (Number.isFinite(target)) {
      const windowMinutes = Number(entry.windowMinutes);
      if (Number.isFinite(windowMinutes) && Math.abs(windowMinutes - target) < 1) {
        return entry;
      }
    }
    if (label && String(entry.resetIn || '').trim().toLowerCase() === label) {
      return entry;
    }
  }
  return null;
}

/**
 * 归一化账本字段。旧记录（只 lastProbeAt/lastActivatedAt）缺字段按 0/'' 读，
 * 等价于「窗口状态未知」→ 上层退回兜底节奏，不会误判成有窗口。
 */
function normalizeLedger(raw = {}) {
  const source = String((raw && raw.windowSource) || '').trim().toLowerCase();
  const windowMinutes = Math.max(0, toMs(raw && raw.windowMinutes, 0));
  const anchorAtMs = Math.max(0, toMs(raw && raw.windowAnchorAtMs, 0));
  const closeAtMs = Math.max(0, toMs(raw && raw.windowCloseAtMs, 0));
  return {
    windowAnchorAtMs: anchorAtMs,
    windowMinutes,
    windowCloseAtMs: closeAtMs,
    windowSource: ['snapshot', 'probe', 'activity'].includes(source) ? source : '',
    windowObservedAtMs: Math.max(0, toMs(raw && raw.windowObservedAtMs, 0)),
    probeFailureCount: Math.max(0, Math.min(MAX_PROBE_FAILURE_COUNT, toMs(raw && raw.probeFailureCount, 0)))
  };
}

/**
 * 观察用量快照：capturedAt 时刻到底有没有活跃窗口？
 *
 * @param {object|null} snapshot 用量快照
 * @param {object|null} spec     probe-specs 的规格（用 windowMatch 识别窗口）
 * @param {{now?: number, lastProbeAt?: number}} [options]
 * @returns {{kind: 'live'|'absent'|'unknown', reason: string, observedAtMs: number,
 *            anchorAtMs: number, closeAtMs: number, windowMinutes: number, entry: object|null}}
 */
function observeWindow(snapshot, spec, options = {}) {
  const lastProbeAt = toMs(options.lastProbeAt, 0);
  const base = {
    kind: 'unknown',
    reason: 'window_entry_missing',
    observedAtMs: toMs(snapshot && snapshot.capturedAt, 0),
    anchorAtMs: 0,
    closeAtMs: 0,
    windowMinutes: 0,
    entry: null
  };
  const entry = findWindowEntry(snapshot, spec && spec.windowMatch, {
    windowMode: spec && spec.windowMode
  });
  if (!entry) return base;
  // 固定窗口 spec（agy）：entry 没有 windowMinutes，时长由规格声明（5h）。
  // 2026-10-19 取证：探测成功 → 快照 resetAtMs ≈ 探测时刻 + 5h，窗口期内读取不移动锚点。
  const declaredMinutes = String(spec && spec.windowMode || '').trim().toLowerCase() === 'fixed'
    ? toPositiveMs(spec && spec.windowMatch && spec.windowMatch.windowMinutes, 0)
    : 0;
  const windowMinutes = toPositiveMs(entry.windowMinutes, declaredMinutes);
  const resetAtMs = toPositiveMs(entry.resetAtMs, 0);
  if (!windowMinutes || !resetAtMs) {
    // 不完整 entry（无 resetAtMs / 无法确定窗口时长）落这里：
    // 观察不出锚点 → 上层退回兜底节奏，绝不猜。
    return { ...base, reason: 'window_entry_unusable', entry };
  }
  if (base.observedAtMs <= 0) {
    // 没有读取时刻就无法区分幻影；宁可不写账本，也不要把假窗口写进去。
    return { ...base, reason: 'capture_time_missing', entry };
  }
  const anchorAtMs = resetAtMs - windowMinutes * MS_PER_MINUTE;
  const captureGapMs = Math.abs(base.observedAtMs - anchorAtMs);
  // 「锚点 ≈ 读取时刻」既可能是幻影，也可能是我们自己刚探过一次开出来的真窗口
  // （探测成功 → 马上读快照）。用探测点消歧：锚点落在某次探测附近 = 那次探测开的窗。
  const probeNearAnchor = lastProbeAt > 0 && Math.abs(lastProbeAt - anchorAtMs) <= PHANTOM_TOLERANCE_MS;
  if (captureGapMs <= PHANTOM_TOLERANCE_MS && !probeNearAnchor) {
    return { ...base, kind: 'absent', reason: 'phantom_reset', windowMinutes, entry };
  }
  return {
    kind: 'live',
    reason: probeNearAnchor ? 'probe_anchor' : 'live_anchor',
    observedAtMs: base.observedAtMs,
    anchorAtMs,
    closeAtMs: resetAtMs,
    windowMinutes,
    entry
  };
}

/**
 * 把观察合并进账本。绝不倒退：只有「比账本已记录更新」的观察才能覆盖。
 * 旧快照（capuredAt 更早）与观察不出来的快照一律原样返回账本。
 */
function reconcileLedger(ledger, observation) {
  const current = normalizeLedger(ledger);
  if (!observation || observation.kind === 'unknown') return current;
  const observedAtMs = toMs(observation.observedAtMs, 0);
  if (observedAtMs <= 0 || observedAtMs <= current.windowObservedAtMs) return current;

  if (observation.kind === 'live') {
    return {
      ...current,
      windowAnchorAtMs: toPositiveMs(observation.anchorAtMs, 0),
      windowMinutes: toPositiveMs(observation.windowMinutes, current.windowMinutes),
      windowCloseAtMs: toPositiveMs(observation.closeAtMs, 0),
      windowSource: 'snapshot',
      windowObservedAtMs: observedAtMs
    };
  }

  // absent：只有「观察到无窗口的时刻」晚于已知关窗时刻才覆盖 —— 否则这条快照与账本
  // 说的是同一件事（当时窗口本来就关着/或更旧的读取），不该把账本往回推。
  if (current.windowCloseAtMs > 0 && observedAtMs <= current.windowCloseAtMs) return current;
  return {
    ...current,
    windowAnchorAtMs: 0,
    windowCloseAtMs: 0,
    windowMinutes: toPositiveMs(observation.windowMinutes, current.windowMinutes),
    windowSource: 'snapshot',
    windowObservedAtMs: observedAtMs
  };
}

/**
 * 把账本翻成「现在窗口处于什么状态」—— 调度决策与界面展示共用同一个视图。
 *
 * open    窗口运行中（closeAtMs 在未来）
 * closed  关窗时刻已过（窗口空着，该续窗了）
 * absent  观察到「没有活跃窗口」（幻影 / 上次读取确认无窗口）
 * unknown 观察不出窗口（快照缺失、provider 无 resetAtMs、旧记录）
 */
function describeWindowView(ledger, nowMs = Date.now()) {
  const current = normalizeLedger(ledger);
  const now = toMs(nowMs, Date.now());
  const closeAtMs = current.windowCloseAtMs;
  if (closeAtMs > 0 && now < closeAtMs) {
    return {
      kind: 'open',
      anchorAtMs: current.windowAnchorAtMs,
      closeAtMs,
      windowMinutes: current.windowMinutes,
      remainingMs: closeAtMs - now,
      source: current.windowSource,
      observedAtMs: current.windowObservedAtMs,
      nextActionAtMs: closeAtMs + PROBE_GRACE_MS
    };
  }
  if (closeAtMs > 0) {
    return {
      kind: 'closed',
      anchorAtMs: current.windowAnchorAtMs,
      closeAtMs,
      windowMinutes: current.windowMinutes,
      remainingMs: 0,
      source: current.windowSource,
      observedAtMs: current.windowObservedAtMs,
      nextActionAtMs: now
    };
  }
  if (current.windowObservedAtMs > 0) {
    return {
      kind: 'absent',
      anchorAtMs: 0,
      closeAtMs: 0,
      windowMinutes: current.windowMinutes,
      remainingMs: 0,
      source: current.windowSource,
      observedAtMs: current.windowObservedAtMs,
      nextActionAtMs: now
    };
  }
  return {
    kind: 'unknown',
    anchorAtMs: 0,
    closeAtMs: 0,
    windowMinutes: current.windowMinutes,
    remainingMs: 0,
    source: '',
    observedAtMs: 0,
    nextActionAtMs: 0
  };
}

/**
 * 把账本锚定到一个已知的窗口起点。
 *
 * 只有两种证据可以锚定：
 *   · source='probe'    我们确认过「当时没有活跃窗口」，探测成功就开出了新窗口 → 锚点=探测时刻；
 *   · source='activity' 关窗后用户自己发了请求 → 新窗口锚点≈那次活动时刻（置信度低，等快照纠正）。
 * 「窗口状态未知」时成功的探测不锚定：那时我们并不知道探测是开了新窗还是落进了旧窗。
 */
function anchorWindowAt(ledger, atMs, windowMinutes, source = 'probe') {
  const current = normalizeLedger(ledger);
  const anchorAtMs = toPositiveMs(atMs, 0);
  const minutes = toPositiveMs(windowMinutes, current.windowMinutes);
  if (!anchorAtMs || !minutes) return current;
  return {
    ...current,
    windowAnchorAtMs: anchorAtMs,
    windowMinutes: minutes,
    windowCloseAtMs: anchorAtMs + minutes * MS_PER_MINUTE,
    windowSource: source === 'activity' ? 'activity' : 'probe',
    windowObservedAtMs: anchorAtMs,
    probeFailureCount: source === 'activity' ? current.probeFailureCount : 0
  };
}

function markProbeFailure(ledger) {
  const current = normalizeLedger(ledger);
  return {
    ...current,
    probeFailureCount: Math.min(MAX_PROBE_FAILURE_COUNT, current.probeFailureCount + 1)
  };
}

// 探测成功即清零失败计数：计数只用来给「失败」做退避。兜底分支（观察不出窗口）的成功
// 探测不锚定账本，但也必须清零 —— 否则每成功一次都被记成一次失败，退避会 10min×n
// 一路累积到封顶（2026-10-16 真机验收实测：outcome=activated 却 fail=1）。
function clearProbeFailure(ledger) {
  const current = normalizeLedger(ledger);
  if (current.probeFailureCount === 0) return current;
  return { ...current, probeFailureCount: 0 };
}

module.exports = {
  PHANTOM_TOLERANCE_MS,
  PROBE_GRACE_MS,
  PROBE_RETRY_BACKOFF_MS,
  ACTIVITY_EPS_MS,
  FIXED_WINDOW_MATCH_SLACK_MS,
  MS_PER_MINUTE,
  listSnapshotEntries,
  findWindowEntry,
  normalizeLedger,
  observeWindow,
  reconcileLedger,
  describeWindowView,
  anchorWindowAt,
  clearProbeFailure,
  markProbeFailure
};
