import type {
  Account,
  CodexResetCredit,
  CodexResetOperation,
  CodexResetOperationOutcome
} from '@/types';

const CHINA_TIME_OFFSET_MS = 8 * 60 * 60 * 1000;
const OPERATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PENDING_OPERATION_STORAGE_PREFIX = 'aih:codex-reset-credit:pending:';

interface CodexResetOperationStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

function twoDigits(value: number): string {
  return String(value).padStart(2, '0');
}

function normalizeAvailableCount(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric >= 0 ? numeric : null;
}

export function isCodexOAuthResetEligible(
  account: Pick<Account, 'provider' | 'configured' | 'apiKeyMode'>
): boolean {
  return account.provider === 'codex' && account.configured && !account.apiKeyMode;
}

export function canConsumeCodexResetCredit(input: {
  supported: boolean;
  detailsComplete: boolean;
  selectableCount: number;
  activeOperation?: Pick<CodexResetOperation, 'status'> | null;
  pendingOperation?: boolean;
}): { allowed: boolean; reason: string } {
  if (!input.supported) {
    return { allowed: false, reason: '当前 Codex 版本未返回重置卡库存' };
  }
  if (input.activeOperation?.status === 'unknown') {
    return { allowed: false, reason: '上一次重置结果待核对' };
  }
  if (input.activeOperation?.status === 'consuming') {
    return { allowed: false, reason: '重置操作正在执行' };
  }
  if (input.pendingOperation) {
    return { allowed: false, reason: '上一次重置操作尚未确认' };
  }
  if (!input.detailsComplete) {
    return { allowed: false, reason: '重置卡明细不完整，无法安全选择最早过期卡' };
  }
  if (input.selectableCount < 1) {
    return { allowed: false, reason: '没有可用的 Codex 重置卡' };
  }
  return { allowed: true, reason: '' };
}

export function listAvailableCodexResetCredits(
  credits: CodexResetCredit[],
  now = Date.now()
): CodexResetCredit[] {
  const currentTime = Number.isFinite(now) ? now : Date.now();
  return (Array.isArray(credits) ? credits : [])
    .filter((credit) => (
      credit?.status === 'available'
      && Number.isFinite(credit.expiresAt)
      && Number(credit.expiresAt) > currentTime
    ))
    .slice()
    .sort((left, right) => {
      const leftExpiry = Number.isFinite(left.expiresAt) ? Number(left.expiresAt) : null;
      const rightExpiry = Number.isFinite(right.expiresAt) ? Number(right.expiresAt) : null;
      if (leftExpiry === null && rightExpiry !== null) return 1;
      if (leftExpiry !== null && rightExpiry === null) return -1;
      if (leftExpiry !== null && rightExpiry !== null && leftExpiry !== rightExpiry) {
        return rightExpiry - leftExpiry;
      }
      return left.creditId.localeCompare(right.creditId);
    });
}

function pendingOperationStorageKey(accountRef: string): string {
  const normalizedRef = String(accountRef || '').trim();
  return normalizedRef
    ? `${PENDING_OPERATION_STORAGE_PREFIX}${encodeURIComponent(normalizedRef)}`
    : '';
}

export function readCodexResetPendingOperationId(
  storage: CodexResetOperationStorage | null | undefined,
  accountRef: string
): string {
  const key = pendingOperationStorageKey(accountRef);
  if (!storage || !key) return '';
  try {
    const operationId = String(storage.getItem(key) || '').trim();
    return OPERATION_ID_PATTERN.test(operationId) ? operationId : '';
  } catch (_error) {
    return '';
  }
}

export function writeCodexResetPendingOperationId(
  storage: CodexResetOperationStorage | null | undefined,
  accountRef: string,
  operationId: string
): boolean {
  const key = pendingOperationStorageKey(accountRef);
  const normalizedId = String(operationId || '').trim();
  if (!storage || !key || !OPERATION_ID_PATTERN.test(normalizedId)) return false;
  try {
    const currentId = String(storage.getItem(key) || '').trim();
    if (OPERATION_ID_PATTERN.test(currentId) && currentId !== normalizedId) return false;
    storage.setItem(key, normalizedId);
    return String(storage.getItem(key) || '').trim() === normalizedId;
  } catch (_error) {
    return false;
  }
}

export function clearCodexResetPendingOperationId(
  storage: CodexResetOperationStorage | null | undefined,
  accountRef: string,
  operationId: string
): boolean {
  const key = pendingOperationStorageKey(accountRef);
  const normalizedId = String(operationId || '').trim();
  if (!storage || !key || !OPERATION_ID_PATTERN.test(normalizedId)) return false;
  try {
    if (String(storage.getItem(key) || '').trim() !== normalizedId) return false;
    storage.removeItem(key);
    return String(storage.getItem(key) || '').trim() !== normalizedId;
  } catch (_error) {
    return false;
  }
}

export function getCodexResetOperationRecoveryDisposition(input: {
  status?: Pick<CodexResetOperation, 'status'>['status'];
  errorCode?: string;
}): 'clear' | 'retain' {
  if (input.status === 'succeeded' || input.status === 'no_effect') return 'clear';
  return String(input.errorCode || '').trim() === 'codex_reset_operation_not_found'
    ? 'clear'
    : 'retain';
}

export function formatChinaDateTime(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  const date = new Date(value + CHINA_TIME_OFFSET_MS);
  return [
    date.getUTCFullYear(),
    twoDigits(date.getUTCMonth() + 1),
    twoDigits(date.getUTCDate())
  ].join('-') + ` ${[
    twoDigits(date.getUTCHours()),
    twoDigits(date.getUTCMinutes()),
    twoDigits(date.getUTCSeconds())
  ].join(':')}`;
}

export function formatCodexResetMenuLabel(
  account: Pick<Account, 'usageSnapshot'>
): string {
  const snapshot = account.usageSnapshot;
  const availableCount = snapshot?.kind === 'codex_oauth_status'
    ? normalizeAvailableCount(snapshot.resetCreditsAvailableCount)
    : null;
  return availableCount === null
    ? '重置额度（可用次数未知）'
    : `重置额度（可用 ${availableCount} 次）`;
}

export function canCloseCodexResetCreditsModal(input: {
  consuming: boolean;
  reconciling: boolean;
}): boolean {
  return !input.consuming && !input.reconciling;
}

export function getCodexResetAvailableCountAfterOperation(
  currentCount: number,
  operation: Pick<CodexResetOperation, 'afterCount' | 'outcome'>
): number {
  const authoritativeCount = operation.afterCount === null
    ? null
    : normalizeAvailableCount(operation.afterCount);
  if (authoritativeCount !== null) return authoritativeCount;
  const normalizedCurrent = normalizeAvailableCount(currentCount) || 0;
  return operation.outcome === 'reset' || operation.outcome === 'alreadyRedeemed'
    ? Math.max(0, normalizedCurrent - 1)
    : normalizedCurrent;
}

export function getCodexResetOutcomeMessage(outcome: CodexResetOperationOutcome): {
  level: 'success' | 'warning';
  text: string;
} {
  switch (outcome) {
    case 'reset':
      return { level: 'success', text: '额度已重置，本次只使用了 1 张卡' };
    case 'alreadyRedeemed':
      return { level: 'success', text: '该操作此前已完成，没有重复使用卡片' };
    case 'nothingToReset':
      return { level: 'warning', text: '当前额度窗口无需重置，卡片未被使用' };
    case 'noCredit':
    default:
      return { level: 'warning', text: '上游未找到这张可用重置卡，请刷新库存' };
  }
}
