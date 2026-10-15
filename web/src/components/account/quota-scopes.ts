import type { AccountUsageSnapshot, CodexUsageEntry, GeminiUsageModel, QuotaEntryShape } from '@/types';

// 额度条目 → 展示行的**唯一派生处**（WebUI 侧）。
//
// 服务端已经按 provider 描述符把快照归一好（条目顺序、label、旁路标记、单位），
// 这里只做投影 + 对老缓存记录的兜底，因此**不再出现按 provider / kind 分支的标签逻辑**。
//
// 与 CLI（lib/usage/quota/view.js）口径一致：
//   * category='gift'/'detail' 是旁路信息，不进账号级 min 剩余、不进行内摘要；
//   * 主额度按窗口长度升序（短的在前），没有窗口长度的排在后面。

export interface QuotaScopeRow {
  key: string;
  label: string;
  shape: QuotaEntryShape;
  category: 'primary' | 'gift' | 'detail';
  remainingPct: number | null;
  resetIn: string;
  resetAtMs: number;
  windowMinutes: number;
  bucket: string;
  model: string;
  totalUnits?: number | null;
  usedUnits?: number | null;
  remainingUnits?: number | null;
  unitType?: string;
  entry: CodexUsageEntry | GeminiUsageModel;
}

const GENERIC_BUCKET_PATTERN = /^(credits?|balance|monthly|monthly_quota|daily|weekly|gift|five_hour(_window)?|seven_day(_window)?|rolling_\d+m)$/;

// 桶名/窗口名的人读化（与服务端 lib/usage/quota/view.js 同一张表）：
// 老缓存记录没有服务端 label 时，展示结果必须与新记录一致。
const BUCKET_LABELS: Record<string, string> = {
  credits: 'Credits',
  credit: 'Credits',
  balance: 'Balance',
  monthly: 'Monthly',
  monthly_quota: 'Monthly',
  five_hour: '5h',
  five_hour_window: '5h',
  seven_day: '7days',
  seven_day_window: '7days',
  daily: 'Daily',
  weekly: 'Weekly',
  gift: 'Gift'
};

function humanizeMinutes(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return '';
  if (minutes % 1440 === 0) return `${minutes / 1440}days`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function humanizeBucket(bucket: string): string {
  const raw = String(bucket || '').trim();
  if (!raw) return '';
  const lower = raw.toLowerCase();
  if (BUCKET_LABELS[lower]) return BUCKET_LABELS[lower];
  const rolling = /^rolling_(\d+)m$/.exec(lower);
  if (rolling) return humanizeMinutes(Number(rolling[1])) || raw;
  const prefixed = /^(gift|detail):(.+)$/.exec(raw);
  if (prefixed) return prefixed[2].trim();
  return raw;
}

function humanizeWindow(window: string): string {
  const raw = String(window || '').trim();
  const minutesOnly = /^(\d+)m$/.exec(raw);
  if (minutesOnly) return humanizeMinutes(Number(minutesOnly[1])) || raw;
  return raw;
}

function normalizePct(value: number | null | undefined): number | null {
  if (value == null) return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.max(0, Math.min(100, numeric));
}

/** 老缓存记录没有服务端 label 时的兜底（与服务端同一条规则）。 */
export function fallbackScopeLabel(entry: CodexUsageEntry | GeminiUsageModel): string {
  const record = entry as unknown as Record<string, unknown>;
  const model = String(record.model || '').trim();
  if (model) return model;
  const bucket = String(record.bucket || '').trim();
  const windowLabel = humanizeWindow(String(record.window || ''));
  if (isNamedBucket(bucket)) return windowLabel ? `${bucket} ${windowLabel}` : bucket;
  if (windowLabel) return windowLabel;
  return humanizeBucket(bucket) || humanizeMinutes(Number(record.windowMinutes)) || 'usage';
}

function resolveCategory(entry: CodexUsageEntry | GeminiUsageModel): QuotaScopeRow['category'] {
  const category = String((entry as CodexUsageEntry).category || '').trim().toLowerCase();
  if (category === 'gift') return 'gift';
  if (category === 'detail') return 'detail';
  return 'primary';
}

function resolveShape(snapshot: AccountUsageSnapshot): QuotaEntryShape {
  if (snapshot.entryShape) return snapshot.entryShape;
  // 老缓存记录：按结构推断（服务端已下发 entryShape，这里只是过渡兜底）。
  if ('models' in snapshot && Array.isArray(snapshot.models)) return 'models';
  if ('entries' in snapshot && Array.isArray(snapshot.entries)) return 'bucket';
  return 'account';
}

function toRows(source: Array<CodexUsageEntry | GeminiUsageModel>, shape: QuotaEntryShape): QuotaScopeRow[] {
  return source.map((entry, index) => {
    const record = entry as CodexUsageEntry;
    const bucket = String(record.bucket || '').trim();
    const model = String((entry as GeminiUsageModel).model || '').trim();
    const identity = model || bucket || String(index);
    const units = shape === 'models'
      ? {}
      : {
          totalUnits: record.totalUnits ?? null,
          usedUnits: record.usedUnits ?? null,
          remainingUnits: record.remainingUnits ?? null,
          unitType: record.unitType || ''
        };
    return {
      key: `${shape}:${identity}:${index}`,
      label: String(record.label || (entry as GeminiUsageModel).label || '').trim() || fallbackScopeLabel(entry),
      shape,
      category: resolveCategory(entry),
      remainingPct: normalizePct(record.remainingPct),
      resetIn: String(record.resetIn || ''),
      resetAtMs: Number(record.resetAtMs) || 0,
      windowMinutes: Number(record.windowMinutes) || 0,
      bucket,
      model,
      ...units,
      entry
    } as QuotaScopeRow;
  });
}

/** 具名桶（模型名 / 套餐名 / 赠送包名）vs 通用桶（credits / 5h / monthly …）。 */
export function isNamedBucket(bucket: string | null | undefined): boolean {
  const value = String(bucket || '').trim();
  if (!value) return false;
  return !GENERIC_BUCKET_PATTERN.test(value.toLowerCase());
}

/** 快照里的全部额度行（主额度在前，gift/detail 在后）。 */
export function getQuotaScopes(snapshot: AccountUsageSnapshot | null | undefined): QuotaScopeRow[] {
  if (!snapshot) return [];
  const shape = resolveShape(snapshot);
  const source: Array<CodexUsageEntry | GeminiUsageModel> = shape === 'models'
    ? (('models' in snapshot && Array.isArray(snapshot.models)) ? snapshot.models : [])
    : (('entries' in snapshot && Array.isArray(snapshot.entries)) ? snapshot.entries : []);
  const rows = toRows(source, shape);
  // 聚合行语义：余额桶里的**通用桶**（credits/balance）在还有每包明细时是账户级总量，
  // 用「账户额度」表达（与旧版 CodeBuddy 卡片一致），不按 provider 分支。
  const hasDetailRows = rows.some((row) => row.category === 'detail');
  const withAggregateLabel = rows.map((row) => (
    hasDetailRows && row.category === 'primary' && !isNamedBucket(row.bucket)
      ? { ...row, label: row.windowMinutes > 0 ? `账户额度 · ${row.label}` : '账户额度' }
      : row
  ));
  const windowKey = (row: QuotaScopeRow) => (row.windowMinutes > 0 ? row.windowMinutes : Number.POSITIVE_INFINITY);
  return withAggregateLabel.slice().sort((left, right) => {
    const byCategory = (left.category === 'primary' ? 0 : 1) - (right.category === 'primary' ? 0 : 1);
    if (byCategory !== 0) return byCategory;
    const byWindow = windowKey(left) - windowKey(right);
    if (Number.isFinite(byWindow) && byWindow !== 0) return byWindow;
    if (left.shape === 'models' && right.shape === 'models') {
      const leftPct = left.remainingPct == null ? Number.POSITIVE_INFINITY : left.remainingPct;
      const rightPct = right.remainingPct == null ? Number.POSITIVE_INFINITY : right.remainingPct;
      if (leftPct !== rightPct) return leftPct - rightPct;
    }
    return 0;
  });
}

/** 账号级额度只看主额度（gift/detail 不参与）。 */
export function getPrimaryQuotaScopes(snapshot: AccountUsageSnapshot | null | undefined): QuotaScopeRow[] {
  return getQuotaScopes(snapshot).filter((row) => row.category === 'primary');
}

/** 账号级最小剩余（与 lib/account/usage-remaining.js 同口径）。 */
export function getMinRemainingPct(snapshot: AccountUsageSnapshot | null | undefined): number | null {
  const values = getPrimaryQuotaScopes(snapshot)
    .map((row) => row.remainingPct)
    .filter((value): value is number => value != null);
  if (values.length === 0) return null;
  return Math.min(...values);
}

/** 账号级剩余是否已知（有任一可渲染条目即视为已知）。 */
export function hasRenderableScopes(snapshot: AccountUsageSnapshot | null | undefined): boolean {
  return getQuotaScopes(snapshot).length > 0;
}
