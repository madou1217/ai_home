import { useCallback, useEffect, useRef, useState } from 'react';
import { Space, Switch, Tag, Typography, message } from 'antd';
import Button from '@/components/ui/AppButton';
import SettingsGroupCard, { SettingsItem } from '@/components/settings/SettingsGroupCard';
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

function arraysEqual(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * 桌面设置页「上游 429 自动重试」卡片：
 * - 绑定完整传输目标与单调 generation（含 endpoint 与管理密钥修订），切服或修改配置立即失效重载；
 * - 仅在当前目标当前 generation 成功读取合法配置后开放编辑与保存（按钮/Enter/handler 同门禁）；
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
          const errMsg = '服务端返回了无效的上游 429 重试配置，已禁止保存以免覆盖当前设置';
          setLoadStatus('error');
          setLoadedGeneration(null);
          setSavedConfig(null);
          setLoadError(errMsg);
          message.error(errMsg);
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
        const errMsg = data?.message || data?.error || '读取上游 429 重试配置失败，已禁止保存以免覆盖当前设置';
        setLoadStatus('error');
        setLoadedGeneration(null);
        setSavedConfig(null);
        setLoadError(errMsg);
        message.error(errMsg);
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
        message.error('保存成功但返回配置结构异常，请重新加载确认');
        loadForScope(capturedScope);
        return;
      }
      setSavedConfig(parsedUpdated);
      setEnabled(parsedUpdated.enabled);
      setScheduleText(formatBackoffSeconds(parsedUpdated.backoffSeconds));
      setLoadError(null);
      setLoadedGeneration(capturedScope.generation);
      setLoadStatus('loaded');
      message.success('上游 429 重试配置已保存并实时生效');
    } catch (error: unknown) {
      if (!mountedRef.current || activeSaveReqRef.current !== saveReqId || !isScopeCurrent(capturedScope)) {
        return;
      }
      const data = typeof error === 'object' && error
        ? (error as { response?: { data?: { message?: string; error?: string } } }).response?.data
        : undefined;
      message.error(data?.message || data?.error || '保存上游 429 重试配置失败');
    } finally {
      if (saveAbortRef.current === controller) {
        saveAbortRef.current = null;
      }
      if (mountedRef.current && activeSaveReqRef.current === saveReqId && isScopeCurrent(capturedScope)) {
        setSaving(false);
      }
    }
  };

  return (
    <SettingsGroupCard
      title="上游 429 自动重试"
      description="仅在请求钉选特定账号，或账号池内已无其它可用账号时生效；多账号池始终优先换号。保存后实时生效，无需重启。"
    >
      {loadStatus === 'error' && loadError ? (
        <SettingsItem
          title="配置读取状态"
          subtitle={loadError}
          action={(
            <Button size="small" onClick={() => loadForScope(scope)}>
              重新加载
            </Button>
          )}
        />
      ) : null}
      <SettingsItem
        title="启用全局 429 等待重试"
        subtitle="关闭后默认遇到上游 HTTP 429 立即返回；单个账号仍可在「运行设置 → 429 重试」中独立覆盖。"
        action={(
          <Space size={8} align="center">
            {loadedForCurrentScope ? (
              <Tag color={enabled ? 'success' : 'default'}>{enabled ? '已启用' : '已关闭'}</Tag>
            ) : (
              <Tag color="default">{loadStatus === 'error' ? '读取失败' : '读取中'}</Tag>
            )}
            <Switch
              id="upstream-429-retry-enabled"
              aria-label="启用全局 429 等待重试"
              checked={loadedForCurrentScope ? enabled : false}
              disabled={controlsDisabled}
              checkedChildren="开"
              unCheckedChildren="关"
              onChange={setEnabled}
            />
          </Space>
        )}
      />
      <SettingsItem
        title="退避等待队列（秒）"
        subtitle="逗号分隔的有序等待秒数，每项为对应重试前的等待时长（默认 30 表示 30s 后重试 1 次）；若上游 Retry-After 更长且未超上限则按其延后。"
        action={(
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 280, maxWidth: 360 }}>
            <BackoffScheduleInput
              id="upstream-429-retry-backoff"
              ariaLabel="全局 429 退避等待队列（秒）"
              value={loadedForCurrentScope ? scheduleText : ''}
              disabled={controlsDisabled}
              onChange={setScheduleText}
              onPressEnter={() => { if (!saveDisabled) void handleSave(); }}
            />
            <Space size={8}>
              <Button
                type="primary"
                disabled={saveDisabled}
                loading={saving}
                onClick={() => void handleSave()}
              >
                保存重试配置
              </Button>
              {dirty && loadedForCurrentScope && savedConfig ? (
                <Button
                  disabled={saving}
                  onClick={() => {
                    setEnabled(savedConfig.enabled);
                    setScheduleText(formatBackoffSeconds(savedConfig.backoffSeconds));
                  }}
                >
                  还原
                </Button>
              ) : null}
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                无需重启服务
              </Typography.Text>
            </Space>
          </div>
        )}
      />
    </SettingsGroupCard>
  );
}
