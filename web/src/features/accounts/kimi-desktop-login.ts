import type { KimiDesktopSessionStatus } from '@/services/api';

export type KimiDesktopLoginPhase = 'loading' | 'error' | KimiDesktopSessionStatus;

export const KIMI_DESKTOP_SESSION_POLL_MS = 2000;

export function resolveKimiDesktopSessionExpiryDelay(
  expiresAtMs: unknown,
  nowMs = Date.now()
): number | null {
  if (typeof expiresAtMs !== 'number' || !Number.isFinite(expiresAtMs) || expiresAtMs <= 0) {
    return null;
  }
  return Math.max(0, expiresAtMs - nowMs);
}

export function resolveKimiDesktopPollPhase(
  status: KimiDesktopSessionStatus,
  expiresAtMs: unknown,
  nowMs = Date.now()
): KimiDesktopSessionStatus {
  // 已在截止时间前发出的轮询可能稍晚返回；官方 SUCCESS 必须优先于本地过期计时器。
  if (status === 'STATUS_SUCCESS') return status;
  if (status === 'STATUS_EXPIRED' || resolveKimiDesktopSessionExpiryDelay(expiresAtMs, nowMs) === 0) {
    return 'STATUS_EXPIRED';
  }
  return status;
}

export function getKimiDesktopSessionStatusText(phase: KimiDesktopLoginPhase): string {
  switch (phase) {
    case 'loading':
      return '正在生成二维码…';
    case 'error':
      return '二维码获取失败';
    case 'STATUS_PENDING':
      return '请用微信扫码';
    case 'STATUS_SCANNED':
      return '已扫码，请在微信中确认登录';
    case 'STATUS_EXPIRED':
      return '二维码已过期';
    case 'STATUS_SUCCESS':
      return '登录成功';
    default:
      return '';
  }
}

export function getKimiDesktopSessionStatusTagColor(phase: KimiDesktopLoginPhase): string {
  switch (phase) {
    case 'STATUS_SCANNED':
      return 'processing';
    case 'STATUS_EXPIRED':
    case 'error':
      return 'warning';
    case 'STATUS_SUCCESS':
      return 'success';
    default:
      return 'default';
  }
}
