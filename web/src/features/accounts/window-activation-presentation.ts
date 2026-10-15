import type {
  AccountWindowActivationGlobalState,
  AccountWindowActivationProbeState
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
  account_not_matched: '未命中该账号（请求回落到了池内其它账号）',
  no_probe_model: '该账号目录里没有可用的探测模型',
  probe_input_invalid: '探测参数无效',
  probe_fetch_unavailable: '本机无法发起探测请求',
  probe_transport_failure: '探测请求未送达网关',
  probe_http_failure: '探测请求失败'
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
      ? `全局开关已开启，未自定义间隔时每 ${defaultInterval} 探测一次。`
      : '全局开关已开启。';
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
    hints.push('该账号还没有探测记录：全局与账号开关都开着后，按间隔或窗口重置点触发。');
  }

  return { tone, label, text, hints };
}
