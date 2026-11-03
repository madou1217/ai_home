/**
 * 网关在线判定的容错策略（纯函数，便于测试）。
 *
 * 之前一次轮询失败就显示 OFFLINE：Wi-Fi 抖一下、Server 正在重启、请求恰好超时，顶栏都会闪
 * 「离线」。现在区分两类失败：
 *   - 配置类（401/403，或 503 webui_unauthorized —— 管理密钥缺失/不匹配）：重试也不会好，立即离线；
 *   - 传输类（断网、超时、5xx、Server 重启中）：快速重试，连续失败达到阈值才离线，
 *     期间保持上一次的状态（并标记为「重连中」由调用方决定是否展示）。
 */

export const OFFLINE_AFTER_FAILURES = 3;
/** 失败后的快速重试间隔（毫秒），之后回到正常轮询节奏。 */
export const RETRY_DELAYS_MS: readonly number[] = [2000, 5000];

export interface GatewayFailureState {
  readonly consecutiveFailures: number;
  readonly offline: boolean;
}

export const INITIAL_FAILURE_STATE: GatewayFailureState = { consecutiveFailures: 0, offline: false };

export function isConfigurationFailure(error: unknown): boolean {
  const response = typeof error === 'object' && error
    ? (error as { response?: { status?: number; data?: { error?: string } } }).response
    : undefined;
  const status = Number(response?.status || 0);
  if (status === 401 || status === 403) return true;
  return status === 503 && response?.data?.error === 'webui_unauthorized';
}

export function recordGatewayFailure(state: GatewayFailureState, error: unknown): GatewayFailureState {
  const consecutiveFailures = state.consecutiveFailures + 1;
  return {
    consecutiveFailures,
    offline: isConfigurationFailure(error) || consecutiveFailures >= OFFLINE_AFTER_FAILURES,
  };
}

export function recordGatewaySuccess(): GatewayFailureState {
  return INITIAL_FAILURE_STATE;
}

/** 下一次轮询的延迟：失败后先快速重试，离线或成功后回到常规间隔。 */
export function nextPollDelay(state: GatewayFailureState, intervalMs: number): number {
  if (state.offline || state.consecutiveFailures === 0) return intervalMs;
  return RETRY_DELAYS_MS[state.consecutiveFailures - 1] ?? intervalMs;
}
