'use strict';

const fs = require('node:fs');

const {
  resolveExpectedIdentity
} = require('./codex-app-server-account-identity');
const {
  createCodexResetCreditStdioTransport
} = require('./codex-reset-credit-stdio-transport');
const {
  buildResetCreditInventoryVersion,
  normalizeResetCreditInventory,
  selectNextResetCredit
} = require('./codex-reset-credit-model');
const {
  completeResetCreditOperation,
  getActiveResetCreditOperation,
  getResetCreditOperation,
  listResetCreditHistory,
  markResetCreditOperationUnknown,
  reserveResetCreditOperation,
  syncResetCreditInventory
} = require('./codex-reset-credit-store');

const OPERATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KNOWN_OUTCOMES = new Set(['reset', 'nothingToReset', 'noCredit', 'alreadyRedeemed']);

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function codedError(code, message, statusCode = 409) {
  const error = new Error(message || code);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function requireOperationId(value) {
  const operationId = text(value);
  if (!OPERATION_ID_PATTERN.test(operationId)) {
    throw codedError('codex_reset_operation_invalid', '重置操作 ID 无效', 400);
  }
  return operationId;
}

function buildDefaultAccountAssertion(options) {
  return (accountRef) => {
    const identity = resolveExpectedIdentity({
      fs: options.fs,
      aiHomeDir: options.aiHomeDir,
      accountRef,
      getProfileDir: options.getProfileDir
    });
    if (identity.kind !== 'oauth') {
      throw codedError(
        'codex_reset_oauth_required',
        '只有 Codex OAuth 账号支持重置额度',
        400
      );
    }
    return true;
  };
}

function withTimeout(promise, timeoutMs) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(codedError(
        'codex_reset_consume_timeout',
        'Codex 重置请求超时，结果需要核对',
        504
      ));
    }, timeoutMs);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function createCodexResetCreditService(options = {}) {
  const fsImpl = options.fs || fs;
  const aiHomeDir = text(options.aiHomeDir);
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const consumeTimeoutMs = Math.max(1, Number(options.consumeTimeoutMs) || 30_000);
  let transport = options.transport || null;
  function getTransport() {
    if (!transport) {
      transport = createCodexResetCreditStdioTransport({
        ...options,
        fs: fsImpl,
        requestTimeoutMs: consumeTimeoutMs
      });
    }
    return transport;
  }
  const assertOAuthAccount = options.assertOAuthAccount || buildDefaultAccountAssertion({
    ...options,
    fs: fsImpl
  });
  const readRateLimits = options.readRateLimits
    || ((...args) => getTransport().readRateLimits(...args));
  const consumeCredit = options.consumeCredit
    || ((...args) => getTransport().consumeCredit(...args));
  const activeRuns = new Map();

  function recoverInterruptedOperation(accountRef, operation) {
    if (!operation || operation.status !== 'consuming') return operation;
    if (activeRuns.get(accountRef)?.operationId === operation.operationId) return operation;
    const currentTime = Number(now()) || Date.now();
    if (currentTime - operation.updatedAt < consumeTimeoutMs) return operation;
    return markResetCreditOperationUnknown(fsImpl, aiHomeDir, {
      operationId: operation.operationId,
      errorCode: 'codex_reset_server_interrupted',
      now: currentTime
    });
  }

  function getActiveOperation(accountRef) {
    return recoverInterruptedOperation(
      accountRef,
      getActiveResetCreditOperation(fsImpl, aiHomeDir, accountRef)
    );
  }

  async function fetchInventory(accountRef) {
    await assertOAuthAccount(accountRef);
    const result = await readRateLimits(accountRef);
    const summary = result && result.rateLimitResetCredits;
    const supported = Boolean(summary && typeof summary === 'object');
    const inventory = normalizeResetCreditInventory(supported ? summary : {});
    const capturedAt = Number(now()) || Date.now();
    syncResetCreditInventory(fsImpl, aiHomeDir, accountRef, inventory, { now: capturedAt });
    const credits = listResetCreditHistory(fsImpl, aiHomeDir, accountRef, { now: capturedAt });
    const inventoryVersion = buildResetCreditInventoryVersion({
      availableCount: inventory.availableCount,
      credits
    });
    const persistedAvailableCount = credits.filter((credit) => credit.status === 'available').length;
    const detailsComplete = supported
      && inventory.detailsComplete
      && persistedAvailableCount === inventory.availableCount;
    return {
      accountRef,
      supported,
      availableCount: inventory.availableCount,
      selectableCount: detailsComplete ? persistedAvailableCount : 0,
      detailsComplete,
      inventoryVersion,
      capturedAt,
      credits
    };
  }

  async function list(accountRef) {
    const snapshot = await fetchInventory(accountRef);
    return {
      ...snapshot,
      nextCreditId: snapshot.detailsComplete
        ? text(selectNextResetCredit(snapshot.credits, snapshot.capturedAt)?.creditId)
        : '',
      activeOperation: getActiveOperation(accountRef)
    };
  }

  function getOperation(input = {}) {
    const operationId = requireOperationId(input.operationId);
    const operation = recoverInterruptedOperation(
      text(input.accountRef),
      getResetCreditOperation(fsImpl, aiHomeDir, operationId)
    );
    if (!operation || operation.accountRef !== text(input.accountRef)) {
      throw codedError('codex_reset_operation_not_found', '重置操作不存在', 404);
    }
    return operation;
  }

  function wrapOperation(operation, extra = {}) {
    return {
      operation,
      reconciliationRequired: operation && operation.status === 'unknown',
      ...extra
    };
  }

  async function executeConsume(input) {
    const { accountRef, operationId, inventoryVersion } = input;
    await assertOAuthAccount(accountRef);
    const existing = recoverInterruptedOperation(
      accountRef,
      getResetCreditOperation(fsImpl, aiHomeDir, operationId)
    );
    if (existing) {
      if (
        existing.accountRef !== accountRef
        || existing.inventoryVersion !== inventoryVersion
      ) {
        throw codedError('codex_reset_idempotency_conflict');
      }
      return wrapOperation(existing);
    }
    const activeOperation = getActiveOperation(accountRef);
    if (activeOperation) {
      throw codedError(
        activeOperation.status === 'unknown'
          ? 'codex_reset_operation_unknown'
          : 'codex_reset_operation_in_progress'
      );
    }

    const snapshot = await fetchInventory(accountRef);
    if (!snapshot.supported) {
      throw codedError('codex_reset_not_supported', '当前 Codex 版本未返回重置卡库存', 400);
    }
    if (!snapshot.detailsComplete) {
      throw codedError(
        'codex_reset_credit_details_incomplete',
        '重置卡明细不完整，无法安全选择最早过期卡',
        409
      );
    }
    if (snapshot.inventoryVersion !== inventoryVersion) {
      throw codedError('codex_reset_inventory_changed', '重置卡库存已变化，请刷新后重试', 409);
    }
    const selected = selectNextResetCredit(snapshot.credits, snapshot.capturedAt);
    if (!selected) {
      throw codedError('codex_reset_credit_unavailable', '没有可用的 Codex 重置卡', 409);
    }

    const reserved = reserveResetCreditOperation(fsImpl, aiHomeDir, {
      operationId,
      accountRef,
      creditId: selected.creditId,
      inventoryVersion,
      beforeCount: snapshot.availableCount,
      now: Number(now()) || Date.now()
    });
    if (!reserved.created) return wrapOperation(reserved.operation);

    let result;
    try {
      result = await withTimeout(consumeCredit(accountRef, {
        idempotencyKey: operationId,
        creditId: selected.creditId
      }), consumeTimeoutMs);
    } catch (error) {
      const unknown = markResetCreditOperationUnknown(fsImpl, aiHomeDir, {
        operationId,
        errorCode: text(error && error.code) || 'codex_reset_result_unknown',
        now: Number(now()) || Date.now()
      });
      return wrapOperation(unknown);
    }
    const outcome = text(result && result.outcome);
    if (!KNOWN_OUTCOMES.has(outcome)) {
      const unknown = markResetCreditOperationUnknown(fsImpl, aiHomeDir, {
        operationId,
        errorCode: 'codex_reset_outcome_unknown',
        now: Number(now()) || Date.now()
      });
      return wrapOperation(unknown);
    }

    let afterCount = null;
    try {
      const after = await fetchInventory(accountRef);
      afterCount = after.availableCount;
    } catch (_error) {
      // 消费 RPC 的结果已经明确；后置库存刷新失败不能把已知结果降级为 unknown。
    }
    const completed = completeResetCreditOperation(fsImpl, aiHomeDir, {
      operationId,
      outcome,
      afterCount,
      now: Number(now()) || Date.now()
    });
    return wrapOperation(completed);
  }

  function consume(input = {}) {
    const accountRef = text(input.accountRef);
    const operationId = requireOperationId(input.operationId);
    const inventoryVersion = text(input.inventoryVersion);
    if (!accountRef || !inventoryVersion) {
      return Promise.reject(codedError('codex_reset_operation_invalid', '重置请求无效', 400));
    }
    const active = activeRuns.get(accountRef);
    if (active) {
      if (active.operationId === operationId) {
        if (
          active.inventoryVersion
          && active.inventoryVersion !== inventoryVersion
        ) {
          return Promise.reject(codedError('codex_reset_idempotency_conflict'));
        }
        return active.promise;
      }
      return Promise.reject(codedError('codex_reset_operation_in_progress'));
    }
    const promise = executeConsume({ accountRef, operationId, inventoryVersion })
      .finally(() => {
        if (activeRuns.get(accountRef)?.operationId === operationId) {
          activeRuns.delete(accountRef);
        }
      });
    activeRuns.set(accountRef, { inventoryVersion, operationId, promise });
    return promise;
  }

  async function executeReconcile(input) {
    const { accountRef, operationId } = input;
    await assertOAuthAccount(accountRef);
    const operation = getOperation({ accountRef, operationId });
    if (operation.status !== 'unknown') return wrapOperation(operation);
    let result;
    try {
      result = await withTimeout(consumeCredit(accountRef, {
        idempotencyKey: operationId,
        creditId: operation.creditId
      }), consumeTimeoutMs);
    } catch (error) {
      const unknown = markResetCreditOperationUnknown(fsImpl, aiHomeDir, {
        operationId,
        errorCode: text(error && error.code) || 'codex_reset_result_unknown',
        now: Number(now()) || Date.now()
      });
      return wrapOperation(unknown);
    }
    const outcome = text(result && result.outcome);
    if (!KNOWN_OUTCOMES.has(outcome)) {
      return wrapOperation(markResetCreditOperationUnknown(fsImpl, aiHomeDir, {
        operationId,
        errorCode: 'codex_reset_outcome_unknown',
        now: Number(now()) || Date.now()
      }));
    }
    if (outcome === 'noCredit') {
      return wrapOperation(markResetCreditOperationUnknown(fsImpl, aiHomeDir, {
        operationId,
        errorCode: 'codex_reset_reconcile_no_credit',
        now: Number(now()) || Date.now()
      }));
    }
    let afterCount = null;
    try {
      afterCount = (await fetchInventory(accountRef)).availableCount;
    } catch (_error) {}
    return wrapOperation(completeResetCreditOperation(fsImpl, aiHomeDir, {
      operationId,
      outcome,
      afterCount,
      now: Number(now()) || Date.now()
    }));
  }

  function reconcile(input = {}) {
    const accountRef = text(input.accountRef);
    const operationId = requireOperationId(input.operationId);
    const active = activeRuns.get(accountRef);
    if (active) {
      if (active.operationId === operationId) return active.promise;
      return Promise.reject(codedError('codex_reset_operation_in_progress'));
    }
    const promise = executeReconcile({ accountRef, operationId })
      .finally(() => {
        if (activeRuns.get(accountRef)?.operationId === operationId) {
          activeRuns.delete(accountRef);
        }
      });
    activeRuns.set(accountRef, { operationId, promise });
    return promise;
  }

  return Object.freeze({
    consume,
    getOperation,
    list,
    reconcile
  });
}

module.exports = {
  createCodexResetCreditService
};
