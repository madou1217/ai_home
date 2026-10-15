import type { KiroNativeLoginPollStatus } from '@/services/kiro-native-login';

// kiro 原生登录弹窗的**纯展示逻辑**（可单测，不含请求）。
// 与 kimi 的 kimi-desktop-login.ts 同形：阶段推导、过期判定、文案与标签色。

export type KiroNativeLoginPhase = 'loading' | 'error' | KiroNativeLoginPollStatus;

/** 轮询间隔下限：设备码流程的服务端 interval 最小 1s，这里不跟着压到 1s，避免打爆上游。 */
export const KIRO_NATIVE_LOGIN_POLL_FLOOR_MS = 2000;

export function resolveKiroLoginPollIntervalMs(intervalSeconds: unknown): number {
  const seconds = Number(intervalSeconds);
  if (!Number.isFinite(seconds) || seconds <= 0) return KIRO_NATIVE_LOGIN_POLL_FLOOR_MS;
  return Math.max(KIRO_NATIVE_LOGIN_POLL_FLOOR_MS, Math.round(seconds * 1000));
}

export function resolveKiroLoginExpiryDelay(expiresAtMs: unknown, nowMs = Date.now()): number | null {
  if (typeof expiresAtMs !== 'number' || !Number.isFinite(expiresAtMs) || expiresAtMs <= 0) return null;
  return Math.max(0, expiresAtMs - nowMs);
}

export function resolveKiroLoginPhase(
  status: KiroNativeLoginPollStatus,
  expiresAtMs: unknown,
  nowMs = Date.now()
): KiroNativeLoginPhase {
  // 已在截止时间前发出的轮询可能稍晚返回；上游明确给出 authorized 必须优先于本地过期计时器。
  if (status === 'authorized') return status;
  if (status === 'expired' || resolveKiroLoginExpiryDelay(expiresAtMs, nowMs) === 0) return 'expired';
  return status;
}

export function isKiroLoginTerminal(phase: KiroNativeLoginPhase): boolean {
  return phase === 'authorized' || phase === 'expired' || phase === 'denied' || phase === 'error';
}

export function getKiroLoginStatusText(phase: KiroNativeLoginPhase): string {
  switch (phase) {
    case 'loading':
      return '正在获取设备码…';
    case 'error':
      return '登录失败';
    case 'pending':
      return '等待授权';
    case 'slow_down':
      return '请求过频，已放慢轮询';
    case 'expired':
      return '设备码已过期';
    case 'denied':
      return '授权被拒绝';
    case 'authorized':
      return '授权成功';
    default:
      return '';
  }
}

export function getKiroLoginStatusTagColor(phase: KiroNativeLoginPhase): string {
  switch (phase) {
    case 'authorized':
      return 'success';
    case 'error':
    case 'expired':
    case 'denied':
      return 'warning';
    case 'slow_down':
      return 'processing';
    default:
      return 'default';
  }
}
