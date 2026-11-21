import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AutoComplete, Input, Select, Switch, message } from 'antd';
import { SaveOutlined } from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import InlineNote from '@/components/ui/InlineNote';
import { providerConfigAPI } from '@/services/api';
import type { ProviderConfigKeySetting, ProviderConfigKeySettingsResponse } from '@/types';

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
}

interface SettingsState {
  loaded: ProviderConfigKeySettingsResponse | null;
  values: Record<string, string>;
}

function describeError(error: unknown): string {
  const response = (error as { response?: { data?: { message?: string } } })?.response;
  return response?.data?.message || (error instanceof Error ? error.message : '请求失败');
}

function isConflict(error: unknown): boolean {
  return (error as { response?: { status?: number } })?.response?.status === 409;
}

function defaultValues(settings: ProviderConfigKeySetting[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (const setting of settings) {
    values[setting.path] = setting.kind === 'boolean' ? String(setting.value || 'false') : String(setting.value || '');
  }
  return values;
}

/**
 * Provider 配置文件的关键设置可视化。
 *
 * 字段声明来自 Go 的 FileDefinition（codex/claude/gemini/agy/opencode/grok …），
 * 读取与保存都走同一份 provider-config 文件、revision 与版本历史——这里只把
 * 最常改的几个键做成表单，不引入第二份配置事实。
 */
export default function ProviderKeySettings({
  provider,
  fileId,
  revision,
  disabled = false,
  disabledReason = '',
  onSaved
}: ProviderKeySettingsProps) {
  const [state, setState] = useState<SettingsState>({ loaded: null, values: {} });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');
  const [statusTone, setStatusTone] = useState<'info' | 'success' | 'error'>('info');
  const requestRef = useRef(0);

  const applyLoaded = useCallback((loaded: ProviderConfigKeySettingsResponse, keepValues: boolean) => {
    setState((current) => ({
      loaded,
      values: keepValues ? { ...defaultValues(loaded.settings), ...current.values } : defaultValues(loaded.settings)
    }));
  }, []);

  useEffect(() => {
    let active = true;
    const requestID = ++requestRef.current;
    setLoading(true);
    providerConfigAPI.keySettings(provider, fileId)
      .then((loaded) => {
        if (!active || requestID !== requestRef.current) return;
        applyLoaded(loaded, false);
        setStatus('');
      })
      .catch((error) => {
        if (!active || requestID !== requestRef.current) return;
        setState({ loaded: null, values: {} });
        setStatusTone('error');
        setStatus(describeError(error));
      })
      .finally(() => {
        if (active && requestID === requestRef.current) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [applyLoaded, fileId, provider, revision]);

  const settings = state.loaded?.settings || [];
  const modelSetting = useMemo(() => settings.find((item) => item.kind === 'model'), [settings]);

  const setValue = useCallback((path: string, value: string) => {
    setState((current) => ({ ...current, values: { ...current.values, [path]: value } }));
  }, []);

  // 模型变化时按新模型刷新推理档位候选；不动其它已编辑的值。
  const refreshEffortChoices = useCallback(async (model: string) => {
    const trimmed = model.trim();
    if (!trimmed) return;
    try {
      const loaded = await providerConfigAPI.keySettings(provider, fileId, trimmed);
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
  }, [fileId, provider]);

  const save = async () => {
    const values: Record<string, string> = {};
    for (const setting of settings) {
      const value = String(state.values[setting.path] ?? '').trim();
      if (setting.kind === 'boolean') {
        values[setting.path] = value || 'false';
        continue;
      }
      if (value) values[setting.path] = value;
    }
    if (!Object.keys(values).length) {
      message.warning('没有可保存的关键设置');
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

  if (loading && !state.loaded) {
    return <div className="pc-key-settings pc-key-settings--loading">正在读取关键设置…</div>;
  }
  if (!settings.length) return null;

  const saveDisabled = disabled || loading || saving || !Object.values(state.values).some((value) => String(value).trim());

  return (
    <section className="pc-key-settings" aria-label="关键设置">
      <div className="pc-key-settings-head">
        <div>
          <strong>关键设置</strong>
          <span>直接写入当前配置文件；保存使用同一份校验与版本历史。</span>
        </div>
      </div>
      <div className="pc-key-settings-grid">
        {settings.map((setting) => {
          const value = String(state.values[setting.path] ?? '');
          const id = `pc-key-${setting.path.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
          return (
            <div className="pc-key-field" key={setting.path}>
              <label htmlFor={id}>{setting.label}</label>
              {setting.kind === 'model' ? (
                <AutoComplete
                  id={id}
                  value={value}
                  options={(setting.choices || []).map((choice) => ({ value: choice, label: choice }))}
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
          onClick={() => void save()}
        >
          保存关键设置
        </Button>
        {disabled && disabledReason ? <span className="pc-key-hint">{disabledReason}</span> : null}
      </div>
      {status ? (
        <InlineNote tone={statusTone === 'success' ? 'success' : statusTone === 'error' ? 'error' : 'info'}>
          {status}
        </InlineNote>
      ) : null}
    </section>
  );
}