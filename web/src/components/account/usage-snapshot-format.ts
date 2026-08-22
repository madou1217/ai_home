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

export function parseResetInDurationMs(resetIn: string | null | undefined) {
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

function formatCompactUnit(value: number) {
  if (value >= 100) return String(Math.round(value));
  if (value >= 10) return value.toFixed(1).replace(/\.0$/, '');
  return value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

/**
 * token 数量的紧凑展示（K/M/B），与账号页 Token 用量列的约定一致：
 * 100000000 → "100M"、1000000000 → "1B"、606408 → "606K"、500 → "500"。
 */
export function formatTokenAmount(value: number | null | undefined) {
  if (value == null || !Number.isFinite(Number(value))) return '-';
  if (value >= 999_500_000) return `${formatCompactUnit(value / 1_000_000_000)}B`;
  if (value >= 999_500) return `${formatCompactUnit(value / 1_000_000)}M`;
  if (value >= 1_000) return `${formatCompactUnit(value / 1_000)}K`;
  return String(Math.round(value));
}

export interface UsageUnitsTooltipLike {
  totalUnits?: number | null;
  usedUnits?: number | null;
  remainingUnits?: number | null;
  remainingPct?: number | null;
  unitType?: string;
}

export interface UsageUnitsTooltipContent {
  title: string;
  detail: string;
}

function resolveUsageUnitLabel(unitType: string | null | undefined) {
  const normalized = String(unitType || '').trim().toLowerCase();
  if (!normalized || normalized === 'token' || normalized === 'tokens') return 'tokens';
  return normalized;
}

/**
 * 由额度条目的绝对数值组装 hover 文案：主行「总 X / 剩余 Y tokens」，
 * 次行「已用 Z」。任何绝对值都不可用时返回 null（不显示 tooltip）。
 */
export function buildUsageUnitsTooltipLines(
  entry: UsageUnitsTooltipLike | null | undefined
): UsageUnitsTooltipContent | null {
  if (!entry) return null;

  const isCountable = (value: number | null | undefined) =>
    value != null && Number.isFinite(Number(value)) && Number(value) >= 0;

  const hasTotal = isCountable(entry.totalUnits) && Number(entry.totalUnits) > 0;
  const hasRemaining = isCountable(entry.remainingUnits);
  if (!hasTotal && !hasRemaining) return null;

  const parts: string[] = [];
  if (hasTotal) parts.push(`总 ${formatTokenAmount(Number(entry.totalUnits))}`);
  if (hasRemaining) parts.push(`剩余 ${formatTokenAmount(Number(entry.remainingUnits))}`);
  const title = `${parts.join(' / ')} ${resolveUsageUnitLabel(entry.unitType)}`;

  const detail = isCountable(entry.usedUnits)
    ? `已用 ${formatTokenAmount(Number(entry.usedUnits))}`
    : '';

  return { title, detail };
}

export interface AgyQuotaModelLike {
  model: string;
  remainingPct: number | null;
  resetIn?: string;
  resetAtMs?: number;
  displayName?: string;
}

export interface AgyQuotaLimitItem {
  key: string;
  label: string;
  remainingPct: number | null;
  resetIn: string;
  resetAtMs: number;
  durationMinutes: number;
}

export interface AgyGroupMemberModel {
  id: string;
  name: string;
}

export interface AgyQuotaGroup {
  key: 'gemini' | 'claude_gpt' | 'other';
  title: string;
  members: AgyGroupMemberModel[];
  memberNames: string[];
  limits: AgyQuotaLimitItem[];
  minRemainingPct: number | null;
}

export function resolveAgyQuotaGroupKey(
  model: string | null | undefined,
  displayName: string | null | undefined = ''
): AgyQuotaGroup['key'] {
  const searchable = `${String(model || '')} ${String(displayName || '')}`.toLowerCase();
  if (searchable.includes('gemini')) return 'gemini';
  if (searchable.includes('claude') || searchable.includes('gpt')) return 'claude_gpt';
  return 'other';
}

/**
 * 把账号级活动收窄到真实额度组。多组但缺少模型时不做猜测，避免全部额度条误燃烧；
 * 单组账号仍可兼容没有 activeModels 字段的旧服务端快照。
 */
export function resolveActiveAgyQuotaGroupKeys(
  groups: AgyQuotaGroup[],
  activeModels: string[] | null | undefined,
  accountRunning: boolean
): AgyQuotaGroup['key'][] {
  const availableGroups = Array.isArray(groups) ? groups : [];
  if (!accountRunning || availableGroups.length === 0) return [];

  const models = (Array.isArray(activeModels) ? activeModels : [])
    .map((model) => String(model || '').trim())
    .filter(Boolean);
  if (models.length === 0) {
    return availableGroups.length === 1 ? [availableGroups[0].key] : [];
  }

  const availableKeys = new Set(availableGroups.map((group) => group.key));
  const memberGroupById = new Map<string, AgyQuotaGroup['key']>();
  for (const group of availableGroups) {
    for (const member of group.members || []) {
      const memberId = String(member.id || '').trim().toLowerCase();
      if (memberId) memberGroupById.set(memberId, group.key);
    }
  }

  const activeKeys = new Set<AgyQuotaGroup['key']>();
  for (const model of models) {
    const exactGroup = memberGroupById.get(model.toLowerCase());
    const groupKey = exactGroup || resolveAgyQuotaGroupKey(model);
    if (availableKeys.has(groupKey)) activeKeys.add(groupKey);
  }

  return availableGroups
    .map((group) => group.key)
    .filter((key) => activeKeys.has(key));
}

function resolveLimitLabel(durationMinutes: number, fallbackName: string): string {
  if (durationMinutes > 0) {
    if (durationMinutes <= 360) return '5h Limit';
    return 'Weekly Limit';
  }
  return fallbackName || 'Limit';
}

export function groupAgyQuotaModels(
  models: AgyQuotaModelLike[] = [],
  nowMs = Date.now()
): AgyQuotaGroup[] {
  const validModels = (Array.isArray(models) ? models : []).filter(
    (m) => m && m.remainingPct != null && Number.isFinite(Number(m.remainingPct))
  );
  if (validModels.length === 0) return [];

  const modelsByGroup: Record<AgyQuotaGroup['key'], AgyQuotaModelLike[]> = {
    gemini: [],
    claude_gpt: [],
    other: []
  };

  for (const item of validModels) {
    modelsByGroup[resolveAgyQuotaGroupKey(item.model, item.displayName)].push(item);
  }

  const buckets: Array<{ key: 'gemini' | 'claude_gpt' | 'other'; title: string; items: AgyQuotaModelLike[] }> = [
    { key: 'gemini', title: 'Gemini Models', items: modelsByGroup.gemini },
    { key: 'claude_gpt', title: 'Claude & GPT Models', items: modelsByGroup.claude_gpt },
    { key: 'other', title: 'Other Models', items: modelsByGroup.other }
  ];

  const result: AgyQuotaGroup[] = [];

  for (const bucket of buckets) {
    if (bucket.items.length === 0) continue;

    // Member models with id and display name (deduplicated by id)
    const memberMap = new Map<string, AgyGroupMemberModel>();
    for (const item of bucket.items) {
      const id = String(item.model || '').trim();
      const name = String(item.displayName || item.model || '').trim();
      if (id && !memberMap.has(id)) {
        memberMap.set(id, { id, name });
      }
    }
    const members = Array.from(memberMap.values());
    const memberNames = members.map((m) => m.name);

    // Limit items deduplication and formatting
    const limitMap = new Map<string, AgyQuotaLimitItem>();

    for (const item of bucket.items) {
      const remainingPct = Math.max(0, Math.min(100, Number(item.remainingPct)));
      const resetAt = Number(item.resetAtMs) || 0;
      let durationMinutes = 0;

      if (resetAt > nowMs) {
        durationMinutes = Math.ceil((resetAt - nowMs) / 60000);
      } else {
        const parsedDurationMs = parseResetInDurationMs(item.resetIn);
        if (parsedDurationMs != null && parsedDurationMs > 0) {
          durationMinutes = Math.ceil(parsedDurationMs / 60000);
        }
      }

      const displayName = String(item.displayName || item.model || '').trim();
      const label = resolveLimitLabel(durationMinutes, displayName);

      const resetSlot = resetAt > 0 ? Math.round(resetAt / (5 * 60 * 1000)) : 0;
      const dedupeKey = `${label}_${Math.round(remainingPct)}_${resetSlot}`;

      const existing = limitMap.get(dedupeKey);
      if (!existing) {
        limitMap.set(dedupeKey, {
          key: dedupeKey,
          label,
          remainingPct,
          resetIn: item.resetIn || '',
          resetAtMs: resetAt,
          durationMinutes
        });
      } else if (remainingPct < (existing.remainingPct ?? 101)) {
        existing.remainingPct = remainingPct;
        existing.resetIn = item.resetIn || existing.resetIn;
        existing.resetAtMs = resetAt || existing.resetAtMs;
      }
    }

    const limits = Array.from(limitMap.values()).sort((a, b) => {
      if (a.durationMinutes !== b.durationMinutes) {
        return a.durationMinutes - b.durationMinutes;
      }
      const aPct = a.remainingPct == null ? 101 : a.remainingPct;
      const bPct = b.remainingPct == null ? 101 : b.remainingPct;
      return aPct - bPct;
    });

    const minRemainingPct = limits.length > 0
      ? Math.min(...limits.map((l) => Number(l.remainingPct ?? 0)))
      : null;

    result.push({
      key: bucket.key,
      title: bucket.title,
      members,
      memberNames,
      limits,
      minRemainingPct
    });
  }

  return result;
}
