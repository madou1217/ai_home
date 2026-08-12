export function formatWindowDuration(windowMinutes: number | null | undefined, fallbackWindow = '') {
  const minutesValue = Number(windowMinutes);
  if (!Number.isFinite(minutesValue) || minutesValue <= 0) return String(fallbackWindow || '').trim();

  const minutes = Math.max(1, Math.round(minutesValue));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const remainingMinutes = minutes % 60;
  const parts: string[] = [];

  if (days > 0) parts.push(`${days}day`);
  if (hours > 0) parts.push(`${hours}h`);
  if (remainingMinutes > 0) parts.push(`${remainingMinutes}m`);

  return parts.join(' ');
}

function parseResetInDurationMs(resetIn: string | null | undefined) {
  const text = String(resetIn || '').trim().toLowerCase();
  if (!text) return null;

  const matcher = /(\d+(?:\.\d+)?)\s*(days?|d|hours?|hrs?|hr|h|minutes?|mins?|min|m|seconds?|secs?|sec|s)/g;
  let totalMs = 0;
  let matched = false;
  let match: RegExpExecArray | null = null;
  while ((match = matcher.exec(text)) !== null) {
    matched = true;
    const value = Number(match[1]);
    if (!Number.isFinite(value) || value < 0) continue;
    const unit = match[2];
    if (unit.startsWith('d')) totalMs += value * 24 * 60 * 60 * 1000;
    else if (unit.startsWith('h')) totalMs += value * 60 * 60 * 1000;
    else if (unit.startsWith('m')) totalMs += value * 60 * 1000;
    else if (unit.startsWith('s')) totalMs += value * 1000;
  }

  return matched ? totalMs : null;
}

export function formatResetIn(
  resetIn: string | null | undefined,
  resetAtMs?: number | null,
  nowMs = Date.now()
) {
  const resetAt = Number(resetAtMs);
  let totalMinutes: number | null = null;

  if (Number.isFinite(resetAt) && resetAt > 0) {
    const remainingMs = resetAt - Number(nowMs);
    totalMinutes = remainingMs > 0 ? Math.ceil(remainingMs / 60000) : 0;
  } else {
    const durationMs = parseResetInDurationMs(resetIn);
    if (durationMs != null) totalMinutes = Math.ceil(durationMs / 60000);
  }

  if (totalMinutes != null) {
    if (totalMinutes <= 0) return '';
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;
    return [
      days > 0 ? `${days}d` : '',
      hours > 0 ? `${hours}h` : '',
      minutes > 0 ? `${minutes}m` : ''
    ].filter(Boolean).join('');
  }

  // The cell promises a compact duration (for example 1d3h25m). Do not
  // leak provider placeholders such as "unknown" or "soon" into that slot.
  return '';
}

export function formatResetAt(resetAtMs: number | null | undefined) {
  const timestamp = Number(resetAtMs);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '';

  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return '';

  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
