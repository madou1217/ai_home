import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Modal, Segmented, Space, Spin, Tag, Typography, message } from 'antd';
import { accountsAPI } from '@/services/api';
import { getAccountPrimaryLabel } from '@/features/accounts/AccountBadges';
import {
  BackoffScheduleInput,
  formatBackoffSeconds,
  parseBackoffSecondsText
} from '@/features/settings/BackoffScheduleInput';
import {
  parseAccountUpstream429RetryResponse,
  useUpstream429TransportScope,
  type Upstream429TransportScope
} from '@/features/settings/use-upstream-429-settings-scope';
import type {
  Account,
  AccountUpstream429RetryEffective,
  AccountUpstream429RetryMode,
  Upstream429RetryGlobalConfig
} from '@/types';
import './account-overlays.css';

interface AccountUpstream429RetryModalProps {
  account: Account | null;
  onClose: () => void;
  /** 嵌在「运行设置」Tab 里：不渲染外层 Modal，保存后不关闭外层。 */
  embedded?: boolean;
}

type LoadStatus = 'idle' | 'loading' | 'loaded' | 'error';

let monotonicAccountLifecycleGen = 0;

function nextAccountLifecycleGen(): number {
  monotonicAccountLifecycleGen += 1;
  return monotonicAccountLifecycleGen;
}

function accountTargetKey(account: Account | null): string {
  if (!account) return '';
  return `${account.provider}:${account.accountRef}`;
}

function describePolicySource(source: AccountUpstream429RetryEffective['source']): string {
  switch (source) {
    case 'account_disabled':
      return '账号强制关闭（覆盖全局）';
    case 'account_custom':
      return '账号自定义启用与退避队列';
    default:
      return '继承全局设置';
  }
}

function previewEffectivePolicy(
  mode: AccountUpstream429RetryMode,
  customSteps: number[] | null,
  globalConfig: Upstream429RetryGlobalConfig
): AccountUpstream429RetryEffective {
  if (mode === 'disabled') {
    return { enabled: false, backoffSeconds: [], source: 'account_disabled' };
  }
  if (mode === 'enabled') {
    return {
      enabled: true,
      backoffSeconds: customSteps && customSteps.length > 0 ? customSteps : [],
      source: 'account_custom'
    };
  }
  return {
    enabled: globalConfig.enabled,
    backoffSeconds: globalConfig.backoffSeconds,
    source: 'global'
  };
}

/**
 * 账号级「上游 HTTP 429 重试覆盖」设置（覆盖所有 OAuth 与 API Key 账号）。
 * - 严格三态：继承全局 / 自定义启用（必须显式填写非空退避队列）/ 强制关闭；优先级高于全局；
 * - 绑定完整传输目标 + 账号身份 + 单调 lifecycle generation，杜绝 A→B→A 串写与读取失败误覆盖。
 */
export function AccountUpstream429RetryModal({
  account,
  onClose,
  embedded = false
}: AccountUpstream429RetryModalProps) {
  const { scope, isScopeCurrent } = useUpstream429TransportScope();
  const currentAccountKey = accountTargetKey(account);

  const [loadStatus, setLoadStatus] = useState<LoadStatus>(account ? 'loading' : 'idle');
  const [lifecycleGen, setLifecycleGen] = useState<number>(() => nextAccountLifecycleGen());
  const [loadedLifecycleGen, setLoadedLifecycleGen] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [mode, setMode] = useState<AccountUpstream429RetryMode>('inherit');
  const [scheduleText, setScheduleText] = useState('');
  const [globalConfig, setGlobalConfig] = useState<Upstream429RetryGlobalConfig | null>(null);

  const mountedRef = useRef(true);
  const lifecycleGenRef = useRef(lifecycleGen);
  const currentAccountKeyRef = useRef(currentAccountKey);
  currentAccountKeyRef.current = currentAccountKey;

  const loadRequestSeqRef = useRef(0);
  const activeLoadReqRef = useRef(0);
  const saveRequestSeqRef = useRef(0);
  const activeSaveReqRef = useRef(0);
  const loadAbortRef = useRef<AbortController | null>(null);
  const saveAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      activeLoadReqRef.current = 0;
      activeSaveReqRef.current = 0;
      loadAbortRef.current?.abort();
      saveAbortRef.current?.abort();
    };
  }, []);

  const isLifecycleCurrent = useCallback((
    capturedGen: number,
    capturedScope: Upstream429TransportScope,
    capturedKey: string
  ): boolean => (
    mountedRef.current
    && lifecycleGenRef.current === capturedGen
    && currentAccountKeyRef.current === capturedKey
    && capturedKey !== ''
    && isScopeCurrent(capturedScope)
  ), [isScopeCurrent]);

  const startLoad = useCallback((
    target: Account,
    capturedGen: number,
    capturedScope: Upstream429TransportScope
  ) => {
    loadAbortRef.current?.abort();
    saveAbortRef.current?.abort();
    activeSaveReqRef.current = 0;

    const capturedKey = accountTargetKey(target);
    const controller = new AbortController();
    loadAbortRef.current = controller;
    loadRequestSeqRef.current += 1;
    const reqId = loadRequestSeqRef.current;
    activeLoadReqRef.current = reqId;

    setLoadStatus('loading');
    setLoadedLifecycleGen(null);
    setLoadError(null);
    setGlobalConfig(null);
    setMode('inherit');
    setScheduleText('');
    setSubmitting(false);

    accountsAPI.getAccountUpstream429Retry(
      target.provider,
      target.accountRef,
      {
        signal: controller.signal,
        boundTarget: capturedScope.target,
        verifyScope: () => activeLoadReqRef.current === reqId && isLifecycleCurrent(capturedGen, capturedScope, capturedKey)
      }
    )
      .then((response) => {
        if (activeLoadReqRef.current !== reqId || !isLifecycleCurrent(capturedGen, capturedScope, capturedKey)) {
          return;
        }
        const parsed = parseAccountUpstream429RetryResponse(response, target.accountRef);
        if (!parsed) {
          const errMsg = '服务端返回了无效的账号 429 重试配置，已禁止保存以免覆盖真实配置';
          setLoadStatus('error');
          setLoadedLifecycleGen(null);
          setGlobalConfig(null);
          setLoadError(errMsg);
          message.error(errMsg);
          return;
        }
        setGlobalConfig(parsed.global);
        setMode(parsed.mode);
        setScheduleText(
          parsed.backoffSeconds.length > 0
            ? formatBackoffSeconds(parsed.backoffSeconds)
            : formatBackoffSeconds(parsed.global.backoffSeconds)
        );
        setLoadError(null);
        setLoadedLifecycleGen(capturedGen);
        setLoadStatus('loaded');
      })
      .catch((error: unknown) => {
        if (activeLoadReqRef.current !== reqId || !isLifecycleCurrent(capturedGen, capturedScope, capturedKey)) {
          return;
        }
        const data = typeof error === 'object' && error
          ? (error as { response?: { data?: { message?: string; error?: string } } }).response?.data
          : undefined;
        const errMsg = data?.message || data?.error || '读取账号 429 重试设置失败，已禁止保存以免覆盖真实配置';
        setLoadStatus('error');
        setLoadedLifecycleGen(null);
        setGlobalConfig(null);
        setLoadError(errMsg);
        message.error(errMsg);
      })
      .finally(() => {
        if (loadAbortRef.current === controller) {
          loadAbortRef.current = null;
        }
      });
  }, [isLifecycleCurrent]);

  const accountProvider = account?.provider ?? '';
  const accountRefValue = account?.accountRef ?? '';
  const latestAccountRef = useRef<Account | null>(account);
  latestAccountRef.current = account;

  // Every open, close, account switch (including A -> B -> A), or server scope/credential
  // change mints a brand-new monotonic lifecycle generation and invalidates prior state.
  // Keyed on provider/accountRef rather than object identity so background account-list polls
  // do not discard the operator's in-progress edits for the same account.
  useEffect(() => {
    const nextGen = nextAccountLifecycleGen();
    lifecycleGenRef.current = nextGen;
    setLifecycleGen(nextGen);

    const target = latestAccountRef.current;
    if (!target || !accountProvider || !accountRefValue) {
      loadAbortRef.current?.abort();
      saveAbortRef.current?.abort();
      activeLoadReqRef.current = 0;
      activeSaveReqRef.current = 0;
      setLoadStatus('idle');
      setLoadedLifecycleGen(null);
      setLoadError(null);
      setGlobalConfig(null);
      setMode('inherit');
      setScheduleText('');
      setSubmitting(false);
      return undefined;
    }

    startLoad(target, nextGen, scope);
    return () => {
      loadAbortRef.current?.abort();
      saveAbortRef.current?.abort();
    };
  }, [accountProvider, accountRefValue, scope, startLoad]);

  const loadedForCurrentTarget =
    Boolean(account)
    && loadStatus === 'loaded'
    && loadedLifecycleGen === lifecycleGen
    && globalConfig !== null
    && !loadError
    && isScopeCurrent(scope);

  const parsedCustom = parseBackoffSecondsText(scheduleText);
  const customInvalid =
    mode === 'enabled'
    && (Boolean(parsedCustom.error) || !parsedCustom.steps || parsedCustom.steps.length === 0);
  const controlsDisabled = !loadedForCurrentTarget || submitting;
  const saveDisabled = controlsDisabled || customInvalid;
  const effectivePreview = loadedForCurrentTarget && globalConfig
    ? previewEffectivePolicy(mode, parsedCustom.steps, globalConfig)
    : null;

  const handleModeChange = (nextMode: AccountUpstream429RetryMode) => {
    if (controlsDisabled) return;
    setMode(nextMode);
    if (nextMode === 'enabled' && !scheduleText.trim() && globalConfig) {
      setScheduleText(formatBackoffSeconds(globalConfig.backoffSeconds));
    }
  };

  const handleReload = () => {
    if (!account) return;
    const nextGen = nextAccountLifecycleGen();
    lifecycleGenRef.current = nextGen;
    setLifecycleGen(nextGen);
    startLoad(account, nextGen, scope);
  };

  const save = async () => {
    const target = account;
    const capturedGen = lifecycleGen;
    const capturedScope = scope;
    const capturedKey = accountTargetKey(target);
    if (
      !target
      || submitting
      || !loadedForCurrentTarget
      || customInvalid
      || !isLifecycleCurrent(capturedGen, capturedScope, capturedKey)
    ) {
      return;
    }

    saveAbortRef.current?.abort();
    const controller = new AbortController();
    saveAbortRef.current = controller;
    saveRequestSeqRef.current += 1;
    const saveReqId = saveRequestSeqRef.current;
    activeSaveReqRef.current = saveReqId;

    const payload = mode === 'enabled'
      ? {
        mode,
        backoffSeconds: parsedCustom.steps ? [...parsedCustom.steps] : []
      }
      : { mode };

    setSubmitting(true);
    try {
      const response = await accountsAPI.saveAccountUpstream429Retry(
        target.provider,
        target.accountRef,
        payload,
        {
          signal: controller.signal,
          boundTarget: capturedScope.target,
          verifyScope: () => activeSaveReqRef.current === saveReqId && isLifecycleCurrent(capturedGen, capturedScope, capturedKey)
        }
      );
      if (activeSaveReqRef.current !== saveReqId || !isLifecycleCurrent(capturedGen, capturedScope, capturedKey)) {
        return;
      }
      const parsed = parseAccountUpstream429RetryResponse(response, target.accountRef);
      if (!parsed) {
        message.error('保存成功但返回配置结构异常，请重新加载确认');
        handleReload();
        return;
      }
      setGlobalConfig(parsed.global);
      setMode(parsed.mode);
      setScheduleText(
        parsed.backoffSeconds.length > 0
          ? formatBackoffSeconds(parsed.backoffSeconds)
          : formatBackoffSeconds(parsed.global.backoffSeconds)
      );
      setLoadError(null);
      setLoadedLifecycleGen(capturedGen);
      setLoadStatus('loaded');
      message.success('账号 429 重试设置已保存并实时生效');
      if (!embedded) onClose();
    } catch (error: unknown) {
      if (activeSaveReqRef.current !== saveReqId || !isLifecycleCurrent(capturedGen, capturedScope, capturedKey)) {
        return;
      }
      const data = typeof error === 'object' && error
        ? (error as { response?: { data?: { message?: string; error?: string } } }).response?.data
        : undefined;
      message.error(data?.message || data?.error || '保存账号 429 重试设置失败');
    } finally {
      if (saveAbortRef.current === controller) {
        saveAbortRef.current = null;
      }
      if (activeSaveReqRef.current === saveReqId && isLifecycleCurrent(capturedGen, capturedScope, capturedKey)) {
        setSubmitting(false);
      }
    }
  };

  const content = (
    <Spin spinning={loadStatus === 'loading'}>
      <Space direction="vertical" size={14} style={{ width: '100%' }}>
        {loadStatus === 'error' && loadError ? (
          <Space size={8} wrap>
            <Typography.Text type="danger">{loadError}</Typography.Text>
            {account ? (
              <Button size="small" onClick={handleReload}>
                重新加载
              </Button>
            ) : null}
          </Space>
        ) : effectivePreview ? (
          <Space size={8} wrap>
            <Tag color={effectivePreview.enabled ? 'success' : 'default'}>
              {effectivePreview.enabled
                ? effectivePreview.backoffSeconds.length > 0
                  ? `当前生效：启用 · [${effectivePreview.backoffSeconds.map((s) => `${s}s`).join(', ')}]`
                  : '当前生效：启用（请填写有效队列）'
                : '当前生效：关闭'}
            </Tag>
            <Typography.Text type="secondary">
              {describePolicySource(effectivePreview.source)}
            </Typography.Text>
          </Space>
        ) : (
          <Typography.Text type="secondary">正在读取账号当前 429 重试设置...</Typography.Text>
        )}

        {loadedForCurrentTarget && globalConfig ? (
          <Typography.Text type="secondary">
            账号设置优先于全局设置（当前全局：{globalConfig.enabled ? '启用' : '关闭'}，队列 [{globalConfig.backoffSeconds.map((s) => `${s}s`).join(', ')}]）。仅对真实上游 HTTP 429 且无其他可用池账号或显式钉选本账号时生效。
          </Typography.Text>
        ) : (
          <Typography.Text type="secondary">
            账号设置优先于全局设置。仅对真实上游 HTTP 429 且无其他可用池账号或显式钉选本账号时生效。
          </Typography.Text>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <Typography.Text strong>覆盖策略</Typography.Text>
          <Segmented
            aria-label="账号 429 重试覆盖模式"
            disabled={controlsDisabled}
            value={mode}
            options={[
              { label: '继承全局', value: 'inherit' },
              { label: '自定义启用', value: 'enabled' },
              { label: '强制关闭', value: 'disabled' }
            ]}
            onChange={(next) => handleModeChange(next as AccountUpstream429RetryMode)}
          />
        </div>

        {loadedForCurrentTarget && mode === 'enabled' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <Typography.Text type="secondary">
              自定义启用使用显式独立队列（切换时已复制当前全局队列作为初始值，可按需修改）。
            </Typography.Text>
            <BackoffScheduleInput
              id="account-upstream-429-retry-backoff"
              ariaLabel="账号自定义 429 退避等待队列（秒）"
              value={scheduleText}
              disabled={controlsDisabled}
              onChange={setScheduleText}
              onPressEnter={() => { if (!saveDisabled) void save(); }}
            />
          </div>
        ) : null}
      </Space>
    </Spin>
  );

  if (embedded) {
    return (
      <div>
        {content}
        <div className="account-panel-actions" style={{ marginTop: 16 }}>
          <Button
            type="primary"
            loading={submitting}
            disabled={saveDisabled}
            onClick={() => void save()}
          >
            保存
          </Button>
        </div>
      </div>
    );
  }

  return (
    <Modal
      open={Boolean(account)}
      title={account ? `429 重试 · ${getAccountPrimaryLabel(account)}` : '429 重试'}
      width={560}
      destroyOnHidden
      maskClosable={!submitting}
      onCancel={onClose}
      footer={[
        <Button key="cancel" disabled={submitting} onClick={onClose}>
          取消
        </Button>,
        <Button
          key="save"
          type="primary"
          loading={submitting}
          disabled={saveDisabled}
          onClick={() => void save()}
        >
          保存
        </Button>
      ]}
    >
      {content}
    </Modal>
  );
}
