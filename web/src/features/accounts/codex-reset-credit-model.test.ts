import assert from 'node:assert/strict';
import test from 'node:test';

let subject: Record<string, any> = {};
try {
  subject = await import('./codex-reset-credit-model.ts');
} catch (_error) {}

const {
  canCloseCodexResetCreditsModal,
  canConsumeCodexResetCredit,
  clearCodexResetPendingOperationId,
  formatChinaDateTime,
  formatCodexResetMenuLabel,
  getCodexResetAvailableCountAfterOperation,
  getCodexResetOperationRecoveryDisposition,
  getCodexResetOutcomeMessage,
  isCodexOAuthResetEligible,
  listAvailableCodexResetCredits,
  readCodexResetPendingOperationId,
  writeCodexResetPendingOperationId
} = subject;

test('only configured Codex OAuth accounts expose the reset-credit action', () => {
  assert.equal(typeof isCodexOAuthResetEligible, 'function');
  assert.equal(isCodexOAuthResetEligible({ provider: 'codex', configured: true, apiKeyMode: false }), true);
  assert.equal(isCodexOAuthResetEligible({ provider: 'codex', configured: true, apiKeyMode: true }), false);
  assert.equal(isCodexOAuthResetEligible({ provider: 'codex', configured: false, apiKeyMode: false }), false);
  assert.equal(isCodexOAuthResetEligible({ provider: 'claude', configured: true, apiKeyMode: false }), false);
});

test('consumption stays disabled for incomplete details, active operations, or empty inventory', () => {
  assert.equal(typeof canConsumeCodexResetCredit, 'function');
  assert.deepEqual(canConsumeCodexResetCredit({
    supported: true,
    detailsComplete: true,
    selectableCount: 1,
    activeOperation: null
  }), { allowed: true, reason: '' });
  assert.equal(canConsumeCodexResetCredit({
    supported: true,
    detailsComplete: false,
    selectableCount: 2,
    activeOperation: null
  }).reason, '重置卡明细不完整，无法安全选择最早过期卡');
  assert.equal(canConsumeCodexResetCredit({
    supported: true,
    detailsComplete: true,
    selectableCount: 1,
    activeOperation: { status: 'unknown' }
  }).reason, '上一次重置结果待核对');
  assert.equal(canConsumeCodexResetCredit({
    supported: true,
    detailsComplete: true,
    selectableCount: 1,
    activeOperation: null,
    pendingOperation: true
  }).reason, '上一次重置操作尚未确认');
});

test('maps consume outcomes to concise UI copy', () => {
  assert.equal(getCodexResetOutcomeMessage('reset').text, '额度已重置，本次只使用了 1 张卡');
  assert.equal(getCodexResetOutcomeMessage('nothingToReset').level, 'warning');
});

test('shows only available cards in reverse expiry order', () => {
  assert.equal(typeof listAvailableCodexResetCredits, 'function');
  const credits = listAvailableCodexResetCredits([
    { creditId: 'used', status: 'consumed', expiresAt: Date.parse('2026-10-01T00:00:00Z') },
    { creditId: 'expired', status: 'available', expiresAt: Date.parse('2026-08-01T00:00:00Z') },
    { creditId: 'earlier', status: 'available', expiresAt: Date.parse('2026-09-01T00:00:00Z') },
    { creditId: 'no-expiry', status: 'available', expiresAt: null },
    { creditId: 'later', status: 'available', expiresAt: Date.parse('2026-09-21T00:00:00Z') }
  ], Date.parse('2026-08-22T00:00:00Z'));

  assert.deepEqual(credits.map((credit: any) => credit.creditId), [
    'later',
    'earlier'
  ]);
});

test('claims one pending operation id per account without overwriting another tab', () => {
  assert.equal(typeof readCodexResetPendingOperationId, 'function');
  assert.equal(typeof writeCodexResetPendingOperationId, 'function');
  assert.equal(typeof clearCodexResetPendingOperationId, 'function');
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) || null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key)
  };
  const firstOperationId = '11111111-1111-4111-8111-111111111111';
  const secondOperationId = '22222222-2222-4222-8222-222222222222';

  assert.equal(writeCodexResetPendingOperationId(storage, 'codex:one', firstOperationId), true);
  assert.equal(readCodexResetPendingOperationId(storage, 'codex:one'), firstOperationId);
  assert.equal(writeCodexResetPendingOperationId(storage, 'codex:one', secondOperationId), false);
  assert.equal(readCodexResetPendingOperationId(storage, 'codex:one'), firstOperationId);
  assert.equal(readCodexResetPendingOperationId(storage, 'codex:two'), '');
  assert.equal(clearCodexResetPendingOperationId(
    storage,
    'codex:one',
    secondOperationId
  ), false);
  assert.equal(readCodexResetPendingOperationId(storage, 'codex:one'), firstOperationId);
  assert.equal(clearCodexResetPendingOperationId(
    storage,
    'codex:one',
    firstOperationId
  ), true);
  assert.equal(readCodexResetPendingOperationId(storage, 'codex:one'), '');

  assert.equal(writeCodexResetPendingOperationId(storage, 'codex:one', secondOperationId), true);
  assert.equal(clearCodexResetPendingOperationId(
    storage,
    'codex:one',
    firstOperationId
  ), false);
  assert.equal(readCodexResetPendingOperationId(storage, 'codex:one'), secondOperationId);
});

test('clears persisted operations only after a terminal result or explicit not-found', () => {
  assert.equal(typeof getCodexResetOperationRecoveryDisposition, 'function');
  assert.equal(getCodexResetOperationRecoveryDisposition({ status: 'succeeded' }), 'clear');
  assert.equal(getCodexResetOperationRecoveryDisposition({ status: 'no_effect' }), 'clear');
  assert.equal(getCodexResetOperationRecoveryDisposition({ status: 'unknown' }), 'retain');
  assert.equal(getCodexResetOperationRecoveryDisposition({ status: 'consuming' }), 'retain');
  assert.equal(getCodexResetOperationRecoveryDisposition({
    errorCode: 'codex_reset_operation_not_found'
  }), 'clear');
  assert.equal(getCodexResetOperationRecoveryDisposition({
    errorCode: 'network_error'
  }), 'retain');
});

test('formats reset-card times as fixed China Standard Time', () => {
  assert.equal(typeof formatChinaDateTime, 'function');
  assert.equal(
    formatChinaDateTime(Date.parse('2026-08-21T23:50:21Z')),
    '2026-08-22 07:50:21'
  );
  assert.equal(formatChinaDateTime(null), '—');
});

test('menu label includes the cached available reset count', () => {
  assert.equal(typeof formatCodexResetMenuLabel, 'function');
  assert.equal(formatCodexResetMenuLabel({
    usageSnapshot: {
      kind: 'codex_oauth_status',
      resetCreditsAvailableCount: 3
    }
  }), '重置额度（可用 3 次）');
  assert.equal(
    formatCodexResetMenuLabel({ usageSnapshot: null }),
    '重置额度（可用次数未知）'
  );
  assert.equal(formatCodexResetMenuLabel({
    usageSnapshot: {
      kind: 'codex_oauth_status',
      resetCreditsAvailableCount: 0
    }
  }), '重置额度（可用 0 次）');
});

test('modal cannot close while a consume or reconciliation request is in flight', () => {
  assert.equal(typeof canCloseCodexResetCreditsModal, 'function');
  assert.equal(canCloseCodexResetCreditsModal({ consuming: false, reconciling: false }), true);
  assert.equal(canCloseCodexResetCreditsModal({ consuming: true, reconciling: false }), false);
  assert.equal(canCloseCodexResetCreditsModal({ consuming: false, reconciling: true }), false);
});

test('publishes the authoritative or safely derived count immediately after an operation', () => {
  assert.equal(typeof getCodexResetAvailableCountAfterOperation, 'function');
  assert.equal(getCodexResetAvailableCountAfterOperation(3, {
    outcome: 'reset',
    afterCount: 1
  }), 1);
  assert.equal(getCodexResetAvailableCountAfterOperation(3, {
    outcome: 'reset',
    afterCount: null
  }), 2);
  assert.equal(getCodexResetAvailableCountAfterOperation(3, {
    outcome: 'nothingToReset',
    afterCount: null
  }), 3);
});
