import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AutoComplete, Input, InputNumber, Select, Segmented, Switch, Tag, Tooltip, message } from 'antd';
import { SaveOutlined } from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import InlineNote from '@/components/ui/InlineNote';
import { accountsAPI, providerConfigAPI } from '@/services/api';
import type { Account, ProviderConfigKeySetting, ProviderConfigKeySettingsResponse } from '@/types';

export interface ProviderKeySettingsProps {
  provider: string;
  fileId: string;
  /** 来自配置文件读取的 revision：编辑器保存或外部修改后刷新关键设置。 */
  revision: string;
  /** 编辑器有未保存修改或文件不可写时禁用保存，避免两份编辑互相覆盖。 */
  disabled?: boolean;
  disabledReason?: string;
  /** 保存成功后由父面板重新读取文件，让编辑器与关键设置保持同一份内容。 */
  onSaved: (revision: string) => void;
  /** 是否声明了关键设置：父面板据此决定是否显示「可视化 / 源码」切换。 */
  onAvailability?: (available: boolean) => void;
}

interface SettingsState {
  loaded: ProviderConfigKeySettingsResponse | null;
  values: Record<string, string>;
  initialValues: Record<string, string>;
}

type Scope = 'public' | 'account';

function describeError(error: unknown): string {
  const response = (error as { response?: { data?: { message?: string } } })?.response;
  return response?.data?.message || (error instanceof Error ? error.message : '请求失败');
}

function isConflict(error: unknown): boolean {
  return (error as { response?: { status?: number } })?.response?.status === 409;
}

function defaultValues(settings: ProviderConfigKeySetting[]): Record<string, string> {
  // 保留读取到的真实值（未设置就是空串）；布尔项的官方默认只在展示层回退。
  const values: Record<string, string> = {};
  for (const setting of settings) {
    values[setting.path] = String(setting.value || '');
  }
  return values;
}

/**
 * Provider 配置文件的关键设置可视化。
 *
 * 公共模式直接读写 Provider 的宿主配置；账号模式只保存该账号的覆盖值，
 * 未覆盖项继承公共配置。两种模式共用同一套字段声明与候选来源。
 */
export default function ProviderKeySettings({
  provider,
  fileId,
  revision,
  disabled = false,
  disabledReason = '',
  onSaved,
  onAvailability
}: ProviderKeySettingsProps) {
  const [state, setState] = useState<SettingsState>({ loaded: null, values: {}, initialValues: {} });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');
  const [statusTone, setStatusTone] = useState<'info' | 'success' | 'error'>('info');
  const [scope, setScope] = useState<Scope>('public');
  const [accountRef, setAccountRef] = useState('');
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(false);
  const requestRef = useRef(0);

  const applyLoaded = useCallback((loaded: ProviderConfigKeySettingsResponse, keepValues: boolean) => {
    const next = defaultValues(loaded.settings);
    setState((current) => ({
      loaded,
      initialValues: next,
      values: keepValues ? { ...next, ...current.values } : next
    }));
  }, []);

  useEffect(() => {
    setScope('public');
    setAccountRef('');
  }, [fileId, provider]);

  useEffect(() => {
    let active = true;
    setAccountsLoading(true);
    accountsAPI.list()
      .then((result) => {
        if (!active) return;
        const normalized = provider.toLowerCase();
        setAccounts((result.accounts || []).filter((item) => String(item.provider || '').toLowerCase() === normalized));
      })
      .catch(() => {
        if (active) setAccounts([]);
      })
      .finally(() => {
        if (active) setAccountsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [provider]);

  const load = useCallback(async (): Promise<ProviderConfigKeySettingsResponse | null> => {
    const requestID = ++requestRef.current;
    setLoading(true);
    try {
      const loaded = await providerConfigAPI.keySettings(provider, fileId, {
        ...(scope === 'account' && accountRef ? { accountRef } : {})
      });
      if (requestID !== requestRef.current) return null;
      applyLoaded(loaded, false);
      setStatus('');
      return loaded;
    } catch (error) {
      if (requestID === requestRef.current) {
        setState({ loaded: null, values: {}, initialValues: {} });
        setStatusTone('error');
        setStatus(describeError(error));
      }
      return null;
    } finally {
      if (requestID === requestRef.current) setLoading(false);
    }
  }, [accountRef, applyLoaded, fileId, provider, scope]);

  useEffect(() => {
    void load();
  }, [load, revision]);

  const settings = state.loaded?.settings || [];
  const modelSetting = useMemo(() => settings.find((item) => item.kind === 'model'), [settings]);
  const accountScope = scope === 'account' && Boolean(accountRef);
  const overrides = state.loaded?.overrides || {};
  const publicValues = state.loaded?.publicValues || {};

  useEffect(() => {
    onAvailability?.(settings.length > 0);
  }, [onAvailability, settings.length]);

  const setValue = useCallback((path: string, value: string) => {
    setState((current) => ({ ...current, values: { ...current.values, [path]: value } }));
  }, []);

  // 模型变化时按新模型刷新推理档位候选；不动其它已编辑的值。
  const refreshEffortChoices = useCallback(async (model: string) => {
    const trimmed = model.trim();
    if (!trimmed) return;
    try {
      const loaded = await providerConfigAPI.keySettings(provider, fileId, {
        model: trimmed,
        ...(scope === 'account' && accountRef ? { accountRef } : {})
      });
      setState((current) => {
        if (!current.loaded) return current;
        return {
          ...current,
          loaded: {
            ...current.loaded,
            settings: current.loaded.settings.map((setting) => {
              const next = loaded.settings.find((item) => item.path === setting.path);
              return next && setting.kind === 'reasoning-effort'
                ? { ...setting, choices: next.choices }
                : setting;
            })
          }
        };
      });
    } catch (_error) {
      // 候选刷新失败不影响已有值；保存时服务端仍会按声明校验。
    }
  }, [accountRef, fileId, provider, scope]);

  const savePublic = async () => {
    const values: Record<string, string> = {};
    for (const setting of settings) {
      const value = String(state.values[setting.path] ?? '').trim();
      const initial = String(state.initialValues[setting.path] ?? '').trim();
      if (value === initial) continue;
      values[setting.path] = setting.kind === 'boolean' ? value || 'false' : value;
    }
    if (!Object.keys(values).length) {
      message.info('关键设置没有变化');
      return;
    }
    setSaving(true);
    try {
      const result = await providerConfigAPI.saveKeySettings(provider, fileId, {
        values,
        revision: state.loaded?.revision || revision
      });
      setStatusTone('success');
      setStatus(result.changed ? '关键设置已保存，配置文件与版本历史已更新。' : '内容没有变化。');
      message.success(result.changed ? '关键设置已保存' : '内容没有变化');
      onSaved(result.revision);
    } catch (error) {
      setStatusTone('error');
      setStatus(isConflict(error) ? '配置文件已被其它进程修改，请重新读取后再保存。' : describeError(error));
      message.error(isConflict(error) ? '配置文件已被其它进程修改' : describeError(error));
    } finally {
      setSaving(false);
    }
  };

  const saveAccount = async () => {
    // 只提交真正发生变化的覆盖/清除；未改动项保持原覆盖或继承。
    const values: Record<string, string> = {};
    for (const setting of settings) {
      const current = String(state.values[setting.path] ?? '').trim();
      const publicValue = String(publicValues[setting.path] ?? '').trim();
      const hasOverride = Object.prototype.hasOwnProperty.call(overrides, setting.path);
      if (hasOverride) {
        const stored = String(overrides[setting.path] ?? '').trim();
        if (current === publicValue) values[setting.path] = '';
        else if (current !== stored) values[setting.path] = current;
      } else if (current !== publicValue) {
        values[setting.path] = current;
      }
    }
    if (!Object.keys(values).length) {
      message.info('账号级设置没有变化');
      return;
    }
    setSaving(true);
    try {
      const result = await providerConfigAPI.saveAccountKeySettings(provider, fileId, accountRef, values);
      setStatusTone('success');
      setStatus(result.changed ? '账号级覆盖已保存；未覆盖项继续继承公共配置。' : '账号级设置没有变化。');
      message.success(result.changed ? '账号级设置已保存' : '账号级设置没有变化');
      await load();
    } catch (error) {
      setStatusTone('error');
      setStatus(describeError(error));
      message.error(describeError(error));
    } finally {
      setSaving(false);
    }
  };

  const resetOverride = async (path: string) => {
    if (!accountScope) return;
    setSaving(true);
    try {
      await providerConfigAPI.saveAccountKeySettings(provider, fileId, accountRef, { [path]: '' });
      message.success('已恢复公共值');
      await load();
    } catch (error) {
      message.error(describeError(error));
    } finally {
      setSaving(false);
    }
  };

  if (loading && !state.loaded) {
    return <div className="pc-key-settings pc-key-settings--loading">正在读取关键设置…</div>;
  }
  if (!settings.length) return null;

  const saveDisabled =
    disabled || loading || saving || (scope === 'account' && !accountRef);

  return (
    <section className="pc-key-settings" aria-label="关键设置">
      <div className="pc-key-settings-head">
        <div>
          <strong>关键设置</strong>
          <span>
            {scope === 'account'
              ? '只覆盖所选账号；未覆盖项继承公共配置，账号启动时生效。'
              : '直接写入公共配置文件；保存使用同一份校验与版本历史。留空表示删除该键、恢复默认。'}
          </span>
        </div>
        <div className="pc-key-scope">
          <Segmented
            size="small"
            value={scope}
            options={[
              { label: '公共', value: 'public' },
              { label: '账号', value: 'account' }
            ]}
            onChange={(value) => {
              setScope(value as Scope);
              if (value === 'public') setAccountRef('');
            }}
          />
          {scope === 'account' ? (
            <Select
              size="small"
              className="pc-key-account-select"
              value={accountRef || undefined}
              loading={accountsLoading}
              options={accounts.map((account) => ({
                value: account.accountRef,
                label: account.displayName || account.accountRef
              }))}
              placeholder={accounts.length ? '选择账号' : '该 Provider 暂无账号'}
              disabled={!accounts.length}
              showSearch
              optionFilterProp="label"
              onChange={(value) => setAccountRef(value || '')}
            />
          ) : null}
        </div>
      </div>
      {accountScope && state.loaded && !state.loaded.accountLaunchSupported ? (
        <InlineNote tone="warning">
          该 CLI 暂未接入账号级启动注入；覆盖会保存，但当前启动仍使用公共配置。
        </InlineNote>
      ) : null}
      <div className="pc-key-settings-grid">
        {settings.map((setting) => {
          const rawValue = String(state.values[setting.path] ?? '');
          const value = rawValue !== '' ? rawValue : String(setting.default || '');
          const hasOverride = Object.prototype.hasOwnProperty.call(overrides, setting.path);
          const id = `pc-key-${setting.path.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
          return (
            <div className="pc-key-field" key={setting.path}>
              <label htmlFor={id}>
                {setting.label}
                {accountScope ? (
                  <span className="pc-key-scope-tags">
                    {hasOverride ? (
                      <Tag bordered={false} color="blue" className="pc-key-scope-tag">自定义</Tag>
                    ) : (
                      <Tag bordered={false} className="pc-key-scope-tag">继承</Tag>
                    )}
                    {setting.launchSupported === false ? (
                      <Tooltip title="该键的账号覆盖会保存，但官方 CLI 没有可用的账号级启动注入；本次启动仍使用公共值。">
                        <Tag bordered={false} color="orange" className="pc-key-scope-tag">仅保存</Tag>
                      </Tooltip>
                    ) : null}
                  </span>
                ) : null}
              </label>
              {setting.kind === 'number' ? (
                <InputNumber
                  id={id}
                  value={value === '' ? null : Number(value)}
                  min={setting.min || undefined}
                  max={setting.max || undefined}
                  step={setting.step || undefined}
                  placeholder={setting.placeholder || '留空使用默认'}
                  onChange={(next) => setValue(setting.path, next === null || next === undefined ? '' : String(next))}
                  style={{ width: '100%' }}
                />
              ) : setting.kind === 'model' ? (
                <AutoComplete
                  id={id}
                  value={value}
                  options={[
                    ...(setting.choices || []).map((choice) => ({ value: choice, label: choice })),
                    ...(setting.unavailableChoices || []).map((choice) => ({
                      value: choice,
                      label: (
                        <span className="pc-key-model-option">
                          {choice}
                          <Tag bordered={false} color="default">无账号</Tag>
                        </span>
                      )
                    }))
                  ]}
                  placeholder={setting.placeholder || '模型 ID'}
                  allowClear
                  filterOption={(input, option) =>
                    String(option?.value || '').toLowerCase().includes(input.toLowerCase())
                  }
                  onChange={(next) => {
                    setValue(setting.path, next);
                  }}
                  onSelect={(next) => {
                    setValue(setting.path, next);
                    if (modelSetting && modelSetting.path === setting.path) void refreshEffortChoices(next);
                  }}
                  onBlur={(event) => {
                    if (modelSetting && modelSetting.path === setting.path) {
                      void refreshEffortChoices((event.target as HTMLInputElement).value);
                    }
                  }}
                />
              ) : setting.kind === 'boolean' ? (
                <Switch
                  id={id}
                  checked={value === 'true'}
                  onChange={(checked) => setValue(setting.path, checked ? 'true' : 'false')}
                />
              ) : setting.kind === 'reasoning-effort' || (setting.choices && setting.choices.length) ? (
                <Select
                  id={id}
                  value={value || undefined}
                  options={(setting.choices || []).map((choice) => ({ value: choice, label: choice }))}
                  placeholder={
                    setting.kind === 'reasoning-effort' && !setting.choices?.length
                      ? '该模型未声明推理档位'
                      : setting.placeholder || '未设置'
                  }
                  allowClear
                  onChange={(next) => setValue(setting.path, next || '')}
                />
              ) : (
                <Input
                  id={id}
                  value={value}
                  placeholder={setting.placeholder || ''}
                  onChange={(event) => setValue(setting.path, event.target.value)}
                />
              )}
              {setting.help ? <small className="pc-key-help">{setting.help}</small> : null}
              {accountScope ? (
                <small className="pc-key-inherit">
                  <Tooltip title={`公共值：${publicValues[setting.path] || '未设置'}`}>
                    <span>{hasOverride ? '公共值已覆盖' : `继承公共：${publicValues[setting.path] || '未设置'}`}</span>
                  </Tooltip>
                  {hasOverride ? (
                    <button type="button" className="pc-key-reset" onClick={() => void resetOverride(setting.path)}>
                      恢复公共
                    </button>
                  ) : null}
                </small>
              ) : null}
            </div>
          );
        })}
      </div>
      <div className="pc-key-settings-foot">
        <Button
          type="primary"
          size="small"
          icon={<SaveOutlined />}
          loading={saving}
          disabled={saveDisabled}
          onClick={() => void (scope === 'account' ? saveAccount() : savePublic())}
        >
          保存关键设置
        </Button>
        {disabled && disabledReason ? <span className="pc-key-hint">{disabledReason}</span> : null}
        {scope === 'account' && !accountRef ? <span className="pc-key-hint">选择账号后才能保存账号级覆盖。</span> : null}
      </div>
      {status ? (
        <InlineNote tone={statusTone === 'success' ? 'success' : statusTone === 'error' ? 'error' : 'info'}>
          {status}
        </InlineNote>
      ) : null}
    </section>
  );
}