import type {
  AccountWindowActivationGlobalState,
  AccountWindowActivationProbeState,
  AccountWindowActivationWindowState
} from '@/types';

/**
 * 「窗口激活」弹窗的展示层：把后端的全局闸门状态与上次探测结果翻成人话。
 *
 * 为什么单独一层：逐账号开关只是两道闸门里的一道 —— 全局 opt-in 关着时，账号页把
 * 开关打开也不会发任何探测。这里集中回答「现在到底会不会探测」，避免页面各自判断。
 */

/** 全局闸门没开时的开启命令（与 `lib/server/server-config-command.js` 的 flag 同源）。 */
export const WINDOW_ACTIVATION_ENABLE_COMMAND = 'aih server config set --window-activation';

const PROBE_OUTCOME_LABELS: Record<string, string> = {
  activated: '已激活窗口',
  matched_upstream_error: '打到了该账号，但上游返回错误（不计为激活）',
  account_not_matched: '未命中该账号（请求回落到了池内其它账号）',
  no_probe_model: '该账号目录里没有可用的探测模型',
  probe_input_invalid: '探测参数无效',
  probe_fetch_unavailable: '本机无法发起探测请求',
  probe_transport_failure: '探测请求未送达网关',
  probe_http_failure: '探测请求失败'
};

/**
 * 调度器「最近一次判定」的原因码 → 人话（账号页据此回答「为什么没探」）。
 * 与 lib/server/window-activation-scheduler.js 的 decideActivation 触发名同源。
 */
const DECISION_REASON_LABELS: Record<string, string> = {
  window_open: '窗口运行中（不探测）',
  window_closed: '窗口已关闭（补探测续窗）',
  window_absent: '没有活跃窗口（补探测开窗）',
  user_reopened: '关窗后账号已被使用（跟随真实使用时刻）',
  close_grace: '刚过关窗时刻（稍后补探测）',
  probe_retry_backoff: '上次探测失败（退避重试中）',
  periodic_fallback: '观察不到窗口，按兜底间隔探测',
  activity_gate: '兜底间隔内已有真实流量（不探测）',
  not_due: '未到兜底间隔（不探测）',
  debounced: '距上次探测太近（不探测）',
  disabled: '账号开关未开启',
  no_spec: '该供应商不支持窗口激活',
  api_key_account: 'API Key 账号没有滚动窗口',
  account_down: '账号已停用',
  runtime_blocked: '账号运行态被阻塞（先解除阻塞才会探测）',
  probe_pending_observation: '已按「无窗口」补探过一次，等待下次观察'
};

const MS_PER_MINUTE = 60 * 1000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;

/** 间隔毫秒 → 「90 分钟」/「4 小时」/「1 小时 30 分钟」；非法值返回空串。 */
export function formatWindowActivationInterval(ms?: number | null): string {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return '';
  if (value < MS_PER_HOUR) return `${Math.round(value / MS_PER_MINUTE)} 分钟`;
  const hours = Math.floor(value / MS_PER_HOUR);
  const minutes = Math.round((value % MS_PER_HOUR) / MS_PER_MINUTE);
  return minutes > 0 ? `${hours} 小时 ${minutes} 分钟` : `${hours} 小时`;
}

/** 探测结果码 → 人话；未知码原样透出（不掩盖上游/网关给的原因）。 */
export function describeWindowActivationOutcome(code?: string | null): string {
  const key = String(code || '').trim();
  if (!key) return '';
  if (PROBE_OUTCOME_LABELS[key]) return PROBE_OUTCOME_LABELS[key];
  const httpMatch = /^http_(\d{3})$/.exec(key);
  if (httpMatch) return `探测返回 HTTP ${httpMatch[1]}`;
  return key;
}

export interface WindowActivationGlobalView {
  /** active=已生效 / inactive=未开启 / unknown=宿主未上报。 */
  tone: 'active' | 'inactive' | 'unknown';
  /** 状态标签文案。 */
  label: string;
  /** 一行状态说明。 */
  text: string;
  /** 补充说明（可能为空数组）：怎么开启、需重启、上次探测结果。 */
  hints: string[];
}

export interface DescribeWindowActivationGlobalInput {
  global?: AccountWindowActivationGlobalState | null;
  lastProbe?: AccountWindowActivationProbeState | null;
  /** 页面已格式化的「上次探测」相对时间（相对时间时钟的产物）；缺省则用绝对信息兜底。 */
  lastProbeRelative?: string | null;
  /** 该账号自己的开关是否已开启（决定是否提示「尚未探测过」）。 */
  accountEnabled?: boolean;
}

export function describeWindowActivationGlobal(
  input: DescribeWindowActivationGlobalInput = {}
): WindowActivationGlobalView {
  const state = input.global || null;
  const enabled = state ? state.enabled : null;
  const defaultInterval = formatWindowActivationInterval(state?.defaultIntervalMs);
  const hints: string[] = [];

  let tone: WindowActivationGlobalView['tone'] = 'unknown';
  let label = '状态未知';
  let text = '当前 Server 未上报全局开关状态，无法确认探测是否生效。';

  if (enabled === true) {
    tone = 'active';
    label = '已生效';
    text = defaultInterval
      ? `窗口关闭后会自动补一次极小探测续窗；观察不到窗口时按 ${defaultInterval} 兜底。`
      : '窗口关闭后会自动补一次极小探测续窗。';
  } else if (enabled === false) {
    tone = 'inactive';
    label = '未生效';
    text = '全局开关未开启，账号开关打开也不会发送任何探测。';
    hints.push(`开启：${WINDOW_ACTIVATION_ENABLE_COMMAND}，然后 aih server restart`);
  }

  if (state?.restartRequired) {
    hints.push(
      state.savedEnabled
        ? '全局开关已保存，重启 Server 后生效。'
        : '全局开关的关闭已保存，重启 Server 后停止探测。'
    );
  }

  const probeAt = Number(input.lastProbe?.at);
  if (Number.isFinite(probeAt) && probeAt > 0) {
    const outcome = describeWindowActivationOutcome(input.lastProbe?.outcome);
    const relative = String(input.lastProbeRelative || '').trim();
    hints.push(`上次探测${relative ? `：${relative}` : ''}${outcome ? ` · ${outcome}` : ''}`);
  } else if (enabled === true && input.accountEnabled === true) {
    hints.push('该账号还没有探测记录：窗口关闭后（或观察不到窗口时）会自动补一次探测。');
  }

  return { tone, label, text, hints };
}

export interface WindowActivationWindowView {
  /** active=窗口运行中 / inactive=等待续窗或补窗 / unknown=观察不到窗口。 */
  tone: 'active' | 'inactive' | 'unknown';
  /** 状态标签文案。 */
  label: string;
  /** 一行状态说明（含下一次动作）。 */
  text: string;
  /** 「最近一次判定」文案；空串表示没有判定记录。 */
  decision: string;
}

export interface DescribeWindowActivationWindowInput {
  window?: AccountWindowActivationWindowState | null;
  /** 关窗时刻的本地格式化文案（绝对时刻，如 `10-16 18:50`）；缺省则只描述动作。 */
  closeAtText?: string | null;
  /** 「最近判定」的相对时间文案。 */
  decisionAtText?: string | null;
  /** 判定时间晚于该时刻才展示（账号开关刚打开时不该翻旧账）；缺省 0。 */
  decisionSinceMs?: number;
  nowMs?: number;
}

/** 判定原因码 → 人话；未知码原样透出（不掩盖调度器给出的原因）。 */
export function describeWindowActivationDecision(reason?: string | null): string {
  const key = String(reason || '').trim();
  if (!key) return '';
  return DECISION_REASON_LABELS[key] || key;
}

/** 毫秒时长 → 「3 小时 20 分钟」/「45 分钟」；非法值返回空串。 */
function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  if (ms < MS_PER_HOUR) return `${Math.max(1, Math.round(ms / MS_PER_MINUTE))} 分钟`;
  const hours = Math.floor(ms / MS_PER_HOUR);
  const minutes = Math.round((ms % MS_PER_HOUR) / MS_PER_MINUTE);
  return minutes > 0 ? `${hours} 小时 ${minutes} 分钟` : `${hours} 小时`;
}

/**
 * 账号级窗口状态（弹窗里的一行紧凑状态）：把账本视图翻成「现在窗口什么状态、
 * 下一步会发生什么」。视图与调度器决策同源（同一个 describeWindowView 的产物）。
 *
 * 返回 null 表示服务端没下发窗口状态（旧版本），调用方不渲染这一行。
 */
export function describeWindowActivationWindow(
  input: DescribeWindowActivationWindowInput = {}
): WindowActivationWindowView | null {
  const state = input.window || null;
  const kind = String(state?.kind || '').trim();
  if (!state || !kind) return null;

  const now = Number.isFinite(Number(input.nowMs)) ? Number(input.nowMs) : Date.now();
  const closeAtText = String(input.closeAtText || '').trim();
  const closeAtMs = Number(state.closeAtMs);
  const remainingText = formatDuration(Number.isFinite(closeAtMs) ? closeAtMs - now : 0);

  let tone: WindowActivationWindowView['tone'] = 'unknown';
  let label = '窗口状态未知';
  let text = '观察不到该账号的窗口（快照缺失或该供应商不提供重置时间），按兜底间隔探测。';

  if (kind === 'open') {
    tone = 'active';
    label = '窗口运行中';
    text = closeAtText
      ? `${closeAtText} 关闭${remainingText ? `（还剩 ${remainingText}）` : ''}，关闭后自动补一次探测续窗。`
      : '关闭后自动补一次探测续窗。';
  } else if (kind === 'closed') {
    tone = 'inactive';
    label = '窗口已关闭';
    text = '等待续窗：下一轮扫描（最多 10 分钟）内补一次极小探测。';
  } else if (kind === 'absent') {
    tone = 'inactive';
    label = '没有活跃窗口';
    text = '已发现窗口空着，会立刻补一次极小探测把窗口重新开起来。';
  }

  const decisionAtMs = Number(state.lastDecision?.at);
  const since = Number(input.decisionSinceMs);
  const showDecision = Number.isFinite(decisionAtMs) && decisionAtMs > 0
    && (!Number.isFinite(since) || since <= 0 || decisionAtMs >= since);
  const decisionLabel = showDecision ? describeWindowActivationDecision(state.lastDecision?.reason) : '';
  const decisionRelative = String(input.decisionAtText || '').trim();
  const decision = decisionLabel
    ? `最近判定：${decisionLabel}${decisionRelative ? ` · ${decisionRelative}` : ''}`
    : '';

  return { tone, label, text, decision };
}
