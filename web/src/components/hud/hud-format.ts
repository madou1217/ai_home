// HUD 顶栏的纯展示格式化（无副作用，便于单测）。

export function formatHudUptime(totalSec: number): string {
  const sec = Math.max(0, Math.floor(Number(totalSec) || 0));
  const days = Math.floor(sec / 86400);
  const hours = Math.floor((sec % 86400) / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  const pad = (value: number) => String(value).padStart(2, '0');
  if (days > 0) return `${days}d ${pad(hours)}h ${pad(minutes)}m`;
  if (hours > 0) return `${hours}h ${pad(minutes)}m`;
  return `${minutes}m ${pad(sec % 60)}s`;
}

export function formatHudPercent(rate: number | null | undefined): string {
  const value = Number(rate);
  if (!Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(1)}%`;
}

export function formatHudCount(value: number | null | undefined): string {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '—';
  return Math.round(numeric).toLocaleString('en-US');
}
