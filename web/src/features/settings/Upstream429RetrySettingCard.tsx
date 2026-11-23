import { useCallback, useEffect, useRef, useState } from 'react';
import { Switch } from 'antd';
import Button from '@/components/ui/AppButton';
import InlineNote from '@/components/ui/InlineNote';
import SettingSection, { SettingRow } from '@/components/ui/SettingSection';
import SettingStatusTag, { type SettingStatusState } from '@/components/ui/SettingStatusTag';
import SaveActionBar from '@/components/ui/SaveActionBar';
import { configAPI } from '@/services/api';
import type { Upstream429RetryGlobalConfig } from '@/types';
import {
  BackoffScheduleInput,
  formatBackoffSeconds,
  parseBackoffSecondsText
} from './BackoffScheduleInput';
import {
  parseGlobalUpstream429RetryConfig,
  useUpstream429TransportScope,
  type Upstream429TransportScope
} from './use-upstream-429-settings-scope';

type LoadStatus = 'loading' | 'loaded' | 'error';

interface RetrySaveFeedback {
  tone: 'success' | 'error';
  text: string;
}

function arraysEqual(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * 桌面设置页「上游 429 自动重试」卡片：
 * - 绑定完整传输目标与单调 generation，切服或修改凭据立即失效重载；
 * - 仅在当前目标当前 generation 成功读取合法配置后开放编辑与保存；
 * - 仅提交 upstream429Retry 局部补丁，保存后实时生效，无需重启。
 */
export default function Upstream429RetrySettingCard() {
  const { scope, isScopeCurrent } = useUpstream429TransportScope();

  const [loadStatus, setLoadStatus] = useState<LoadStatus>('loading');
  const [loadedGeneration, setLoadedGeneration] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedConfig, setSavedConfig] = useState<Upstream429RetryGlobalConfig | null>(null);
  const [enabled, setEnabled] = useState<boolean>(false);
  const [scheduleText, setScheduleText] = useState<string>('');
  const [feedback, setFeedback] = useState<RetrySaveFeedback | null>(null);

  const mountedRef = useRef(true);
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

  const loadForScope = useCallback((capturedScope: Upstream429TransportScope) => {
    loadAbortRef.current?.abort();
    saveAbortRef.current?.abort();
    activeSaveReqRef.current = 0;

    const controller = new AbortController();
    loadAbortRef.current = controller;
    loadRequestSeqRef.current += 1;
    const reqId = loadRequestSeqRef.current;
    activeLoadReqRef.current = reqId;

    setLoadStatus('loading');
    setLoadedGeneration(null);
    setLoadError(null);
    setSavedConfig(null);
    setSaving(false);
    setFeedback(null);

    configAPI.getServer({
      signal: controller.signal,
      boundTarget: capturedScope.target,
      verifyScope: () => mountedRef.current && activeLoadReqRef.current === reqId && isScopeCurrent(capturedScope)
    })
      .then((server) => {
        if (!mountedRef.current || activeLoadReqRef.current !== reqId || !isScopeCurrent(capturedScope)) {
          return;
        }
        const parsedConfig = parseGlobalUpstream429RetryConfig(server);
        if (!parsedConfig) {
          const errMsg = '服务端返回了无效的 429 重试配置，已禁止保存以免覆盖当前设置';
          setLoadStatus('error');
          setLoadedGeneration(null);
          setSavedConfig(null);
          setLoadError(errMsg);
          return;
        }
        setSavedConfig(parsedConfig);
        setEnabled(parsedConfig.enabled);
        setScheduleText(formatBackoffSeconds(parsedConfig.backoffSeconds));
        setLoadError(null);
        setLoadedGeneration(capturedScope.generation);
        setLoadStatus('loaded');
      })
      .catch((error: unknown) => {
        if (!mountedRef.current || activeLoadReqRef.current !== reqId || !isScopeCurrent(capturedScope)) {
          return;
        }
        const data = typeof error === 'object' && error
          ? (error as { response?: { data?: { message?: string; error?: string } } }).response?.data
          : undefined;
        const errMsg = data?.message || data?.error || '读取 429 重试配置失败，已禁止保存';
        setLoadStatus('error');
        setLoadedGeneration(null);
        setSavedConfig(null);
        setLoadError(errMsg);
      })
      .finally(() => {
        if (loadAbortRef.current === controller) {
          loadAbortRef.current = null;
        }
      });
  }, [isScopeCurrent]);

  useEffect(() => {
    loadForScope(scope);
  }, [scope, loadForScope]);

  const loadedForCurrentScope =
    loadStatus === 'loaded'
    && loadedGeneration === scope.generation
    && savedConfig !== null
    && !loadError
    && isScopeCurrent(scope);

  const parsed = parseBackoffSecondsText(scheduleText);
  const dirty = loadedForCurrentScope && (
    enabled !== savedConfig.enabled
    || (parsed.steps !== null && !arraysEqual(parsed.steps, savedConfig.backoffSeconds))
  );
  const controlsDisabled = !loadedForCurrentScope || saving;
  const saveDisabled = controlsDisabled || !dirty || Boolean(parsed.error) || !parsed.steps;

  const sectionStatus: SettingStatusState = saving
    ? 'saving'
    : loadStatus === 'error' || feedback?.tone === 'error'
      ? 'error'
      : !loadedForCurrentScope
        ? 'saving'
        : dirty
          ? 'dirty'
          : 'applied';

  const sectionStatusLabel = !loadedForCurrentScope && loadStatus === 'loading'
    ? '读取中'
    : loadStatus === 'error'
      ? '读取失败'
      : undefined;

  const handleSave = async () => {
    const capturedScope = scope;
    if (
      saving
      || !loadedForCurrentScope
      || !dirty
      || Boolean(parsed.error)
      || !parsed.steps
      || !isScopeCurrent(capturedScope)
    ) {
      return;
    }

    saveAbortRef.current?.abort();
    const controller = new AbortController();
    saveAbortRef.current = controller;
    saveRequestSeqRef.current += 1;
    const saveReqId = saveRequestSeqRef.current;
    activeSaveReqRef.current = saveReqId;

    const payloadEnabled = enabled;
    const payloadSteps = [...parsed.steps];

    setSaving(true);
    setFeedback(null);
    try {
      const updatedServer = await configAPI.updateServer(
        {
          upstream429Retry: {
            enabled: payloadEnabled,
            backoffSeconds: payloadSteps
          }
        },
        {
          signal: controller.signal,
          boundTarget: capturedScope.target,
          verifyScope: () => mountedRef.current && activeSaveReqRef.current === saveReqId && isScopeCurrent(capturedScope)
        }
      );
      if (!mountedRef.current || activeSaveReqRef.current !== saveReqId || !isScopeCurrent(capturedScope)) {
        return;
      }
      const parsedUpdated = parseGlobalUpstream429RetryConfig(updatedServer);
      if (!parsedUpdated) {
        setFeedback({ tone: 'error', text: '返回结构异常，正在重新读取确认' });
        loadForScope(capturedScope);
        return;
      }
      const formatted = formatBackoffSeconds(parsedUpdated.backoffSeconds);
      setSavedConfig(parsedUpdated);
      setEnabled(parsedUpdated.enabled);
      setScheduleText(formatted);
      setLoadError(null);
      setLoadedGeneration(capturedScope.generation);
      setLoadStatus('loaded');
      setFeedback({
        tone: 'success',
        text: `已应用：${parsedUpdated.enabled ? '已启用' : '已关闭'}，退避队列 ${formatted}s`
      });
    } catch (error: unknown) {
      if (!mountedRef.current || activeSaveReqRef.current !== saveReqId || !isScopeCurrent(capturedScope)) {
        return;
      }
      const data = typeof error === 'object' && error
        ? (error as { response?: { data?: { message?: string; error?: string } } }).response?.data
        : undefined;
      setFeedback({
        tone: 'error',
        text: data?.message || data?.error || '保存 429 重试配置失败'
      });
    } finally {
      if (saveAbortRef.current === controller) {
        saveAbortRef.current = null;
      }
      if (mountedRef.current && activeSaveReqRef.current === saveReqId && isScopeCurrent(capturedScope)) {
        setSaving(false);
      }
    }
  };

  const handleReset = () => {
    if (!savedConfig) return;
    setEnabled(savedConfig.enabled);
    setScheduleText(formatBackoffSeconds(savedConfig.backoffSeconds));
    setFeedback(null);
  };

  return (
    <SettingSection
      title="上游 429 自动重试"
      description="仅在钉选单账号或无可用替代账号时触发，多账号池始终优先换号。"
      status={<SettingStatusTag status={sectionStatus} label={sectionStatusLabel} compact />}
      footer={
        <SaveActionBar
          dirty={dirty}
          saving={saving}
          disabled={saveDisabled}
          onSave={() => void handleSave()}
          onReset={handleReset}
          status={sectionStatus}
          statusLabel={sectionStatusLabel}
          saveLabel="保存重试配置"
          cleanSaveLabel="已应用"
          effectSummary="保存后实时生效，无需重启服务"
          feedback={feedback?.text}
          feedbackTone={feedback?.tone ?? 'muted'}
        />
      }
    >
      {loadStatus === 'error' && loadError ? (
        <InlineNote
          tone="error"
          className="settings-inline-alert"
          action={<Button size="small" onClick={() => loadForScope(scope)}>重新加载</Button>}
        >
          {loadError}
        </InlineNote>
      ) : null}

      <SettingRow
        title="启用全局 429 等待重试"
        htmlFor="upstream-429-retry-enabled"
        description="关闭后遇到上游 HTTP 429 立即返回。"
        persistedValue={
          loadedForCurrentScope && savedConfig
            ? `已应用：${savedConfig.enabled ? '已启用' : '已关闭'}`
            : undefined
        }
        caveat="单个账号可在“运行设置 → 429 重试”中独立覆盖。"
        status={
          loadedForCurrentScope ? (
            <SettingStatusTag
              status={enabled !== savedConfig?.enabled ? 'dirty' : enabled ? 'applied' : 'unset'}
              label={enabled !== savedConfig?.enabled ? (enabled ? '待启用' : '待关闭') : enabled ? '已启用' : '已关闭'}
              compact
            />
          ) : null
        }
        control={
          <Switch
            id="upstream-429-retry-enabled"
            aria-label="启用全局 429 等待重试"
            checked={loadedForCurrentScope ? enabled : false}
            disabled={controlsDisabled}
            checkedChildren="开"
            unCheckedChildren="关"
            onChange={(checked) => {
              setEnabled(checked);
              if (feedback) setFeedback(null);
            }}
          />
        }
      />

      <SettingRow
        title="退避等待队列（秒）"
        htmlFor="upstream-429-retry-backoff"
        description="逗号分隔的等待秒数，默认 30 表示等待 30 秒后重试 1 次。"
        persistedValue={
          loadedForCurrentScope && savedConfig
            ? `已应用：${formatBackoffSeconds(savedConfig.backoffSeconds)}s`
            : undefined
        }
        caveat="若上游 Retry-After 更长且未超上限，按其延后。"
        layout="stacked"
        control={
          <BackoffScheduleInput
            id="upstream-429-retry-backoff"
            ariaLabel="全局 429 退避等待队列（秒）"
            value={loadedForCurrentScope ? scheduleText : ''}
            disabled={controlsDisabled}
            onChange={(next) => {
              setScheduleText(next);
              if (feedback) setFeedback(null);
            }}
            onPressEnter={() => { if (!saveDisabled) void handleSave(); }}
          />
        }
      />
    </SettingSection>
  );
}
