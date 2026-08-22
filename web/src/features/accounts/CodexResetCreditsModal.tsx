import { Button, Empty, Modal, Popconfirm, Spin, Typography, message } from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { accountsAPI } from '@/services/api';
import type {
  Account,
  CodexResetCredit,
  CodexResetCreditsResponse,
  CodexResetOperation
} from '@/types';
import {
  canCloseCodexResetCreditsModal,
  canConsumeCodexResetCredit,
  clearCodexResetPendingOperationId,
  formatChinaDateTime,
  getCodexResetAvailableCountAfterOperation,
  getCodexResetOperationRecoveryDisposition,
  getCodexResetOutcomeMessage,
  listAvailableCodexResetCredits,
  readCodexResetPendingOperationId,
  writeCodexResetPendingOperationId
} from './codex-reset-credit-model';
import './CodexResetCreditsModal.css';

const OPERATION_POLL_MS = 1_500;

interface CodexResetCreditsModalProps {
  open: boolean;
  account: Account | null;
  onClose: () => void;
  onAvailableCountChange: (accountRef: string, availableCount: number) => void;
}

type OperationRecoveryStatus = 'idle' | 'checking' | 'blocked' | 'reuse';

function createOperationId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const value = Math.floor(Math.random() * 16);
    return (char === 'x' ? value : (value & 0x3) | 0x8).toString(16);
  });
}

function errorMessage(error: any, fallback: string): string {
  return String(error?.response?.data?.message || error?.response?.data?.error || error?.message || fallback);
}

function errorCode(error: any): string {
  return String(error?.response?.data?.error || error?.code || '').trim();
}

function browserStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch (_error) {
    return null;
  }
}

function emitOutcome(operation: CodexResetOperation) {
  const outcome = getCodexResetOutcomeMessage(operation.outcome);
  message[outcome.level](outcome.text);
}

export function CodexResetCreditsModal({
  open,
  account,
  onClose,
  onAvailableCountChange
}: CodexResetCreditsModalProps) {
  const accountRef = account?.accountRef || '';
  const [inventory, setInventory] = useState<CodexResetCreditsResponse | null>(null);
  const [recoveredOperation, setRecoveredOperation] = useState<CodexResetOperation | null>(null);
  const [pendingOperationId, setPendingOperationId] = useState('');
  const [loading, setLoading] = useState(false);
  const [consuming, setConsuming] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [recoveryStatus, setRecoveryStatus] = useState<OperationRecoveryStatus>('idle');
  const actionLockRef = useRef(false);
  const operationIdRef = useRef('');
  const generationRef = useRef(0);

  const publishAvailableCount = useCallback((availableCount: number) => {
    if (!accountRef) return;
    onAvailableCountChange(accountRef, Math.max(0, Math.trunc(availableCount)));
  }, [accountRef, onAvailableCountChange]);

  const publishOperationAvailableCount = useCallback((operation: CodexResetOperation) => {
    publishAvailableCount(getCodexResetAvailableCountAfterOperation(
      operation.beforeCount,
      operation
    ));
  }, [publishAvailableCount]);

  const persistOperationId = useCallback((operationId: string) => {
    if (!writeCodexResetPendingOperationId(browserStorage(), accountRef, operationId)) {
      return false;
    }
    operationIdRef.current = operationId;
    setPendingOperationId(operationId);
    return true;
  }, [accountRef]);

  const clearPendingOperation = useCallback((operationId: string) => {
    if (operationIdRef.current && operationIdRef.current !== operationId) return false;
    const storage = browserStorage();
    const cleared = clearCodexResetPendingOperationId(storage, accountRef, operationId);
    const currentOperationId = readCodexResetPendingOperationId(storage, accountRef);
    if (currentOperationId && currentOperationId !== operationId) {
      operationIdRef.current = currentOperationId;
      setPendingOperationId(currentOperationId);
      setRecoveryStatus('blocked');
      return false;
    }
    if (!cleared && currentOperationId === operationId) return false;
    operationIdRef.current = '';
    setPendingOperationId('');
    return true;
  }, [accountRef]);

  const setActiveOperation = useCallback((operation: CodexResetOperation) => {
    if (!persistOperationId(operation.operationId)) {
      setRecoveryStatus('blocked');
      return false;
    }
    setRecoveredOperation(operation);
    setInventory((current) => current ? { ...current, activeOperation: operation } : current);
    return true;
  }, [persistOperationId]);

  const handleTerminalOperation = useCallback((operation: CodexResetOperation) => {
    if (getCodexResetOperationRecoveryDisposition({ status: operation.status }) !== 'clear') {
      return false;
    }
    const cleared = clearPendingOperation(operation.operationId);
    setRecoveredOperation((current) => current?.operationId === operation.operationId ? null : current);
    setInventory((current) => (
      current?.activeOperation?.operationId === operation.operationId
        ? { ...current, activeOperation: null }
        : current
    ));
    if (cleared) setRecoveryStatus('idle');
    publishOperationAvailableCount(operation);
    emitOutcome(operation);
    return true;
  }, [clearPendingOperation, publishOperationAvailableCount]);

  const queryPendingOperation = useCallback(async (operationId: string) => {
    const generation = generationRef.current;
    setRecoveryStatus('checking');
    try {
      const operation = await accountsAPI.getCodexResetOperation(accountRef, operationId);
      if (generationRef.current !== generation) return 'stale';
      if (handleTerminalOperation(operation)) return 'terminal';
      if (!setActiveOperation(operation)) return 'blocked';
      setRecoveryStatus('idle');
      return 'active';
    } catch (error) {
      if (generationRef.current !== generation) return 'stale';
      const code = errorCode(error);
      if (getCodexResetOperationRecoveryDisposition({ errorCode: code }) === 'clear') {
        const cleared = clearPendingOperation(operationId);
        setRecoveredOperation((current) => current?.operationId === operationId ? null : current);
        setInventory((current) => (
          current?.activeOperation?.operationId === operationId
            ? { ...current, activeOperation: null }
            : current
        ));
        if (cleared) setRecoveryStatus('idle');
        return 'not_found';
      }
      operationIdRef.current = operationId;
      setPendingOperationId(operationId);
      setRecoveryStatus('blocked');
      message.error(errorMessage(error, '上一次重置状态暂时无法确认'));
      return 'blocked';
    }
  }, [accountRef, clearPendingOperation, handleTerminalOperation, setActiveOperation]);

  const loadInventory = useCallback(async () => {
    if (!accountRef) return null;
    const generation = generationRef.current;
    try {
      const result = await accountsAPI.listCodexResetCredits(accountRef);
      if (generationRef.current !== generation) return null;
      setInventory(result);
      publishAvailableCount(result.availableCount);
      if (result.activeOperation) {
        const currentOperationId = operationIdRef.current;
        if (currentOperationId && currentOperationId !== result.activeOperation.operationId) {
          setRecoveryStatus('blocked');
        } else {
          const persisted = setActiveOperation(result.activeOperation);
          setRecoveryStatus(persisted ? 'idle' : 'blocked');
        }
      } else if (!operationIdRef.current) {
        setRecoveredOperation(null);
        setRecoveryStatus('idle');
      }
      return result;
    } catch (error) {
      if (generationRef.current === generation) {
        message.error(errorMessage(error, '读取 Codex 重置卡失败'));
      }
      return null;
    }
  }, [accountRef, publishAvailableCount, setActiveOperation]);

  useEffect(() => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    actionLockRef.current = false;
    operationIdRef.current = '';
    setInventory(null);
    setRecoveredOperation(null);
    setPendingOperationId('');
    setLoading(false);
    setConsuming(false);
    setReconciling(false);
    setRecoveryStatus('idle');
    if (!open || !accountRef) return undefined;

    const initialize = async () => {
      setLoading(true);
      const storedOperationId = readCodexResetPendingOperationId(browserStorage(), accountRef);
      if (storedOperationId) {
        operationIdRef.current = storedOperationId;
        setPendingOperationId(storedOperationId);
        await queryPendingOperation(storedOperationId);
      }
      if (generationRef.current === generation) await loadInventory();
      if (generationRef.current === generation) setLoading(false);
    };
    void initialize();

    return () => {
      if (generationRef.current === generation) generationRef.current += 1;
    };
  }, [accountRef, loadInventory, open, queryPendingOperation]);

  const inventoryOperation = inventory?.activeOperation || null;
  const activeOperation = pendingOperationId
    ? [recoveredOperation, inventoryOperation].find(
      (operation) => operation?.operationId === pendingOperationId
    ) || null
    : inventoryOperation || recoveredOperation;

  useEffect(() => {
    if (!open || !accountRef || activeOperation?.status !== 'consuming') return undefined;
    const generation = generationRef.current;
    let stopped = false;
    const poll = async () => {
      try {
        const operation = await accountsAPI.getCodexResetOperation(
          accountRef,
          activeOperation.operationId
        );
        if (stopped || generationRef.current !== generation) return;
        if (handleTerminalOperation(operation)) {
          await loadInventory();
          return;
        }
        setActiveOperation(operation);
        if (operation.status === 'unknown') {
          message.warning('重置结果暂不明确，账号已锁定；请核对结果，不会切换到下一张卡');
        }
      } catch (error) {
        if (stopped || generationRef.current !== generation) return;
        if (getCodexResetOperationRecoveryDisposition({ errorCode: errorCode(error) }) === 'clear') {
          clearPendingOperation(activeOperation.operationId);
          setRecoveredOperation(null);
          await loadInventory();
        }
      }
    };
    const timer = window.setInterval(() => void poll(), OPERATION_POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [
    accountRef,
    activeOperation?.operationId,
    activeOperation?.status,
    clearPendingOperation,
    handleTerminalOperation,
    loadInventory,
    open,
    setActiveOperation
  ]);

  const availableCredits = useMemo(() => listAvailableCodexResetCredits(
    inventory?.credits || []
  ), [inventory?.credits]);
  const pendingWithoutActiveOperation = Boolean(
    pendingOperationId && !activeOperation && recoveryStatus !== 'reuse'
  );
  const recoveryNeedsQuery = recoveryStatus === 'checking'
    || recoveryStatus === 'blocked'
    || pendingWithoutActiveOperation;
  const consumeAvailability = canConsumeCodexResetCredit({
    supported: Boolean(inventory?.supported),
    detailsComplete: Boolean(inventory?.detailsComplete),
    selectableCount: availableCredits.length,
    activeOperation,
    pendingOperation: recoveryNeedsQuery
  });

  const consume = useCallback(async () => {
    if (actionLockRef.current || !inventory || !consumeAvailability.allowed) return;
    const generation = generationRef.current;
    actionLockRef.current = true;
    setConsuming(true);
    const operationId = pendingOperationId || createOperationId();
    if (!persistOperationId(operationId)) {
      const storedOperationId = readCodexResetPendingOperationId(browserStorage(), accountRef);
      if (storedOperationId) {
        operationIdRef.current = storedOperationId;
        setPendingOperationId(storedOperationId);
        setRecoveryStatus('blocked');
        message.warning('检测到其他页面有未确认的重置操作，请先重新查询');
      } else {
        message.error('浏览器无法保存本次重置操作，为避免重复消耗已取消请求');
      }
      setConsuming(false);
      actionLockRef.current = false;
      return;
    }
    try {
      const result = await accountsAPI.consumeCodexResetCredit(accountRef, {
        operationId,
        inventoryVersion: inventory.inventoryVersion
      });
      if (generationRef.current !== generation) return;
      if (!handleTerminalOperation(result.operation)) {
        setActiveOperation(result.operation);
        setRecoveryStatus('idle');
        message.warning('重置结果暂不明确，账号已锁定；请核对结果，不会切换到下一张卡');
      } else {
        await loadInventory();
      }
    } catch (error) {
      if (generationRef.current !== generation) return;
      const code = errorCode(error);
      if (code === 'codex_reset_inventory_changed') {
        setRecoveryStatus('reuse');
        message.warning(errorMessage(error, '重置卡库存已变化，请重新确认'));
        await loadInventory();
      } else {
        setRecoveryStatus('blocked');
        message.error(errorMessage(error, 'Codex 额度重置结果暂时无法确认'));
        if (
          code === 'codex_reset_operation_in_progress'
          || code === 'codex_reset_operation_unknown'
        ) {
          await loadInventory();
        }
      }
    } finally {
      if (generationRef.current === generation) {
        actionLockRef.current = false;
        setConsuming(false);
      }
    }
  }, [
    accountRef,
    consumeAvailability.allowed,
    handleTerminalOperation,
    inventory,
    loadInventory,
    pendingOperationId,
    persistOperationId,
    setActiveOperation
  ]);

  const reconcile = useCallback(async () => {
    const operationId = activeOperation?.operationId || pendingOperationId;
    if (actionLockRef.current || !operationId) return;
    const generation = generationRef.current;
    actionLockRef.current = true;
    setReconciling(true);
    if (!persistOperationId(operationId)) {
      setRecoveryStatus('blocked');
      setReconciling(false);
      actionLockRef.current = false;
      message.error('检测到其他页面的重置操作，已停止本次核对');
      return;
    }
    try {
      const result = await accountsAPI.reconcileCodexResetOperation(accountRef, operationId);
      if (generationRef.current !== generation) return;
      if (!handleTerminalOperation(result.operation)) {
        setActiveOperation(result.operation);
        setRecoveryStatus('idle');
        message.warning('仍无法确认结果；账号继续保持锁定，不会消费其他卡片');
      } else {
        await loadInventory();
      }
    } catch (error) {
      if (generationRef.current !== generation) return;
      const code = errorCode(error);
      if (getCodexResetOperationRecoveryDisposition({ errorCode: code }) === 'clear') {
        const cleared = clearPendingOperation(operationId);
        setRecoveredOperation(null);
        if (cleared) setRecoveryStatus('idle');
        await loadInventory();
      } else {
        setRecoveryStatus('blocked');
        message.error(errorMessage(error, '核对 Codex 重置结果失败'));
      }
    } finally {
      if (generationRef.current === generation) {
        actionLockRef.current = false;
        setReconciling(false);
      }
    }
  }, [
    accountRef,
    activeOperation?.operationId,
    clearPendingOperation,
    handleTerminalOperation,
    loadInventory,
    pendingOperationId,
    persistOperationId,
    setActiveOperation
  ]);

  const retryRecovery = useCallback(async () => {
    const operationId = pendingOperationId || readCodexResetPendingOperationId(
      browserStorage(),
      accountRef
    );
    if (actionLockRef.current || !operationId) return;
    const generation = generationRef.current;
    actionLockRef.current = true;
    setReconciling(true);
    try {
      await queryPendingOperation(operationId);
      if (generationRef.current === generation) await loadInventory();
    } finally {
      if (generationRef.current === generation) {
        actionLockRef.current = false;
        setReconciling(false);
      }
    }
  }, [accountRef, loadInventory, pendingOperationId, queryPendingOperation]);

  const consumeRequestPending = consuming || activeOperation?.status === 'consuming';
  const closeAllowed = canCloseCodexResetCreditsModal({
    consuming: consumeRequestPending,
    reconciling: reconciling || recoveryStatus === 'checking'
  });
  const handleClose = () => {
    if (closeAllowed) onClose();
  };

  const statusText = recoveryStatus === 'checking'
    ? '正在核对上一次重置操作…'
    : recoveryStatus === 'blocked'
      ? '上一次重置状态暂时无法确认，已禁止再次消耗。'
      : recoveryStatus === 'reuse'
        ? '库存已更新，可继续使用同一次操作重试。'
        : activeOperation?.status === 'unknown'
          ? '上一次重置结果待核对，不会切换到下一张卡。'
          : activeOperation?.status === 'consuming'
            ? '重置处理中，请勿关闭窗口。'
            : inventory && (!inventory.supported || !inventory.detailsComplete)
              ? consumeAvailability.reason
              : '';
  const statusType = recoveryStatus === 'blocked'
    || activeOperation?.status === 'unknown'
    || Boolean(inventory && (!inventory.supported || !inventory.detailsComplete))
    ? 'warning'
    : 'secondary';

  const footerAction = recoveryNeedsQuery ? (
    <Button
      type="primary"
      loading={reconciling || recoveryStatus === 'checking'}
      disabled={loading || recoveryStatus === 'checking'}
      onClick={() => void retryRecovery()}
    >
      重新查询
    </Button>
  ) : activeOperation?.status === 'unknown' ? (
    <Button type="primary" loading={reconciling} onClick={() => void reconcile()}>
      核对结果
    </Button>
  ) : (
    <Popconfirm
      title="确认重置额度？"
      description={consumeAvailability.allowed
        ? '每次仅消耗 1 次重置额度。'
        : consumeAvailability.reason}
      okText="重置"
      cancelText="取消"
      disabled={!consumeAvailability.allowed || consumeRequestPending || loading}
      onConfirm={consume}
    >
      <Button
        type="primary"
        disabled={!consumeAvailability.allowed || loading}
        loading={consumeRequestPending}
      >
        重置
      </Button>
    </Popconfirm>
  );

  return (
    <Modal
      className="codex-reset-credits-modal"
      open={open}
      title="重置额度"
      width={560}
      destroyOnHidden
      closable={closeAllowed}
      maskClosable={closeAllowed}
      keyboard={closeAllowed}
      onCancel={handleClose}
      footer={footerAction}
    >
      {loading ? (
        <div className="codex-reset-credits__loading"><Spin /></div>
      ) : inventory ? (
        <div className="codex-reset-credits">
          {statusText ? (
            <Typography.Text
              type={statusType}
              className="codex-reset-credits__status"
              role="status"
            >
              {statusText}
            </Typography.Text>
          ) : null}

          <div className="codex-reset-credits__table-wrap">
            <table className="codex-reset-credits__table">
              <thead>
                <tr>
                  <th scope="col">序号</th>
                  <th scope="col">过期时间</th>
                </tr>
              </thead>
              <tbody>
                {availableCredits.length > 0 ? availableCredits.map((credit: CodexResetCredit, index) => (
                  <tr key={credit.creditId}>
                    <td>{index + 1}</td>
                    <td>{formatChinaDateTime(credit.expiresAt)}</td>
                  </tr>
                )) : (
                  <tr>
                    <td colSpan={2} className="codex-reset-credits__empty">
                      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无可用重置额度" />
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="无法读取重置额度" />
      )}
    </Modal>
  );
}
