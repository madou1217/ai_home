import { useEffect, useMemo, useState } from 'react';
import { Input, Modal, Select, Spin, Switch, Tabs, Tooltip, message } from 'antd';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  FileTextOutlined,
  InfoCircleOutlined,
  SafetyCertificateOutlined,
  SwapOutlined,
  WarningOutlined
} from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import InlineNote from '@/components/ui/InlineNote';
import { resolveOrderedDirection, useSurfaceSwitch } from '@/hooks/use-surface-switch';
import { toolkitAPI } from '@/services/api';
import type {
  ManagedAppItem,
  ToolPermissionCapability,
  ToolPermissionFlagEntry,
  ToolPermissionSettings
} from '@/types';
import ProviderConfigPanel from '@/features/provider-config/ProviderConfigPanel';
import ProviderNetworkSettings from '@/features/provider-config/ProviderNetworkSettings';
import { supportsClaudePreflight } from '@/components/toolkit/managed-app-capabilities';
import { toolkitRequestError as requestError } from '@/components/toolkit/request-error';
import ClaudePreflightSettings from './ClaudePreflightSettings';
import {
  blockingSubcommands,
  describeSelectionCommand,
  disabledFlags,
  findFlagEntry,
  findSelectionConflicts,
  findSelectionOverrides,
  flagTakesValue,
  flagValueOptions,
  groupPermissionFlags,
  parsePermissionArgs,
  removeSelection,
  resolveLaunchPlan,
  serializePermissionArgs,
  upsertSelection,
  type PermissionSelection
} from './permission-catalog-view';
import './app-advanced-settings.css';

function hostStateText(capability: ToolPermissionCapability): string {
  if (!capability.hostSupported) {
    return capability.hostReason
      ? `不可写入宿主配置（${capability.hostReason}）`
      : '不可写入宿主配置';
  }
  if (!capability.hostExists) return '宿主配置文件尚未创建，保存时会自动创建';
  if (!capability.hostWritable) return '宿主配置文件当前不可写，保存会失败';
  return '宿主配置文件已存在，保存前会自动备份';
}

/** 应用名 → CLI 可执行名（示例命令里用）。 */
function executableName(app: ManagedAppItem | null, provider: string): string {
  const candidate = String(app?.binaryName || '').trim();
  return candidate || provider || 'cli';
}

export interface AppAdvancedSettingsModalProps {
  open: boolean;
  app: ManagedAppItem | null;
  onClose: () => void;
  busy?: boolean;
  installingHooks?: boolean;
  onInstallHooks?: (provider: string) => void;
  onUninstallHooks?: (provider: string) => void;
}

export default function AppAdvancedSettingsModal({
  open,
  app,
  onClose,
  busy = false,
  installingHooks = false,
  onInstallHooks,
  onUninstallHooks
}: AppAdvancedSettingsModalProps) {
  const provider = app?.provider || '';
  const [activeTab, setActiveTab] = useState('permission');
  const { surfaceRef: paneSurfaceRef, switchSurface: switchPaneSurface } = useSurfaceSwitch<HTMLDivElement>();
  const [settings, setSettings] = useState<ToolPermissionSettings | null>(null);
  const [capability, setCapability] = useState<ToolPermissionCapability | null>(null);
  const [selections, setSelections] = useState<PermissionSelection[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [reloadToken, setReloadToken] = useState(0);

  const showPermissionTab = app?.type === 'cli' && app?.permissionSupported === true;
  // 首屏检查与启动权限、配置文件一起收在同一个应用高级设置里。
  const showPreflightTab = supportsClaudePreflight(app);
  const showConfigTab = Boolean(provider && (app?.configFileCount || 0) > 0);
  const tabs = useMemo(() => {
    const items = [];
    if (showPermissionTab) {
      items.push({ key: 'permission', label: '启动权限' });
    }
    if (showPreflightTab) {
      items.push({ key: 'preflight', label: '首屏检查' });
    }
    if (showConfigTab) {
      items.push({ key: 'config', label: '配置文件' });
      items.push({ key: 'inspector', label: '参数解读' });
    }
    // 网络对所有 agent/harness 都可用：官方账号需要验证网络或设置代理，
    // 默认出口跟随 OAuth 授权网络，账号可独立覆盖。
    items.push({ key: 'network', label: '网络' });
    return items;
  }, [showConfigTab, showPermissionTab, showPreflightTab]);

  useEffect(() => {
    if (!open) return;
    setActiveTab(showPermissionTab ? 'permission' : (showConfigTab ? 'config' : 'network'));
  }, [open, provider, showConfigTab, showPermissionTab]);

  useEffect(() => {
    if (!open || !provider || !showPermissionTab) {
      setSettings(null);
      setCapability(null);
      setSelections([]);
      setError('');
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError('');
    toolkitAPI.getAppPermissionSettings(provider)
      .then((response) => {
        if (cancelled) return;
        setSettings(response.settings);
        setCapability(response.capability);
        setSelections(parsePermissionArgs(
          response.capability.permissionCatalog,
          response.settings.permissionArgs
        ));
      })
      .catch((requestFailure: unknown) => {
        if (cancelled) return;
        setError(requestError(requestFailure, '读取启动权限设置失败'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, provider, reloadToken, showPermissionTab]);

  const catalog = capability?.permissionCatalog || null;
  const groups = useMemo(() => groupPermissionFlags(catalog), [catalog]);
  const blocked = useMemo(() => disabledFlags(catalog, selections), [catalog, selections]);
  const conflicts = useMemo(() => findSelectionConflicts(catalog, selections), [catalog, selections]);
  const overrides = useMemo(() => findSelectionOverrides(catalog, selections), [catalog, selections]);
  const resumeBlocked = useMemo(() => blockingSubcommands(catalog), [catalog]);
  const missingValues = useMemo(
    () => selections.filter((selection) => {
      const entry = findFlagEntry(catalog, selection.flag);
      return Boolean(entry && flagTakesValue(entry) && !String(selection.value || '').trim());
    }),
    [catalog, selections]
  );

  const permissionArgs = useMemo(
    () => serializePermissionArgs(catalog, selections),
    [catalog, selections]
  );

  const launchPreview = selections.length
    ? permissionArgs.join(' ')
    : (capability?.maxArgs?.length ? capability.maxArgs.join(' ') : '');

  const exampleCommand = useMemo(() => {
    if (!catalog) return '';
    const sample = selections.length
      ? selections
      : parsePermissionArgs(catalog, capability?.maxArgs || []);
    return describeSelectionCommand(executableName(app, provider), sample);
  }, [app, capability, catalog, provider, selections]);

  // 与能力目录默认最大权限等价的逐项选择，仍可写入宿主配置。
  const sameAsMaxArgs = Boolean(
    capability
    && permissionArgs.length === (capability.maxArgs || []).length
    && permissionArgs.every((arg, index) => arg === capability.maxArgs[index])
  );
  const customArgs = sameAsMaxArgs ? [] : permissionArgs;
  const hostUsable = Boolean(
    capability?.hostSupported && (!capability.hostExists || capability.hostWritable)
  );
  const launchPlan = capability && settings
    ? resolveLaunchPlan({
        resumeBlocked,
        maxPermission: settings.maxPermission,
        applyToHost: settings.applyToHost,
        customArgs,
        maxArgs: capability.maxArgs || [],
        hostSupported: capability.hostSupported,
        hostExists: capability.hostExists,
        hostWritable: capability.hostWritable
      })
    : null;

  const savePermission = async () => {
    if (!provider || !settings) return;
    setSaving(true);
    setError('');
    try {
      const response = await toolkitAPI.saveAppPermissionSettings(provider, {
        maxPermission: settings.maxPermission,
        applyToHost: settings.applyToHost,
        permissionArgs
      });
      setSettings(response.settings);
      setCapability(response.capability);
      setSelections(parsePermissionArgs(
        response.capability.permissionCatalog,
        response.settings.permissionArgs
      ));
      if (response.hostApply?.applied) {
        message.success(response.hostApply.changed
          ? '启动权限已保存，并写入宿主配置文件'
          : '启动权限已保存，宿主配置已是最新');
      } else {
        message.success('启动权限已保存，新开的 aih CLI 会话会使用该设置');
      }
    } catch (requestFailure: unknown) {
      setError(requestError(requestFailure, '保存启动权限失败'));
    } finally {
      setSaving(false);
    }
  };

  const toggleFlag = (entry: ToolPermissionFlagEntry, checked: boolean) => {
    if (!checked) {
      setSelections((current) => removeSelection(current, entry.flag));
      return;
    }
    const { options, freeform } = flagValueOptions(entry);
    const defaultValue = freeform ? '' : (options[0] || '');
    setSelections((current) => upsertSelection(current, entry.flag, defaultValue));
  };

  const changeFlagValue = (entry: ToolPermissionFlagEntry, value: string) => {
    setSelections((current) => upsertSelection(current, entry.flag, value));
  };

  return (
    <Modal
      open={open}
      title={app ? `${app.name} · 高级设置` : '高级设置'}
      width={1160}
      footer={null}
      destroyOnClose
      onCancel={onClose}
      className="app-advanced-settings-modal"
    >
      {!app ? null : (
        <div className="aas-shell">
          {tabs.length > 1 ? (
            <Tabs
              activeKey={activeTab}
              animated={{ inkBar: true, tabPane: false }}
              onChange={(nextTab) => {
                const order = tabs.map((item) => item.key);
                switchPaneSurface(() => setActiveTab(nextTab), {
                  current: activeTab,
                  next: nextTab,
                  direction: resolveOrderedDirection(order, activeTab, nextTab)
                });
              }}
              items={tabs}
              className="aas-tabs"
            />
          ) : (
            <div className="aas-single-title">{tabs[0]?.label || '高级设置'}</div>
          )}

          <div ref={paneSurfaceRef}>
          {activeTab === 'permission' && showPermissionTab ? (
            <div className="aas-permission-pane">
              {app?.installed && app.hookSupported ? (
                <section className="aas-section aas-sync-section">
                  <div className="aas-section-head">
                    <FileTextOutlined />
                    <div>
                      <strong>即时刷新</strong>
                      <span>监听本机 CLI 会话事件；CLI 写入新回合后，WebUI 会立即重新读取本地会话文件并更新列表。</span>
                    </div>
                    {app.hookInstalled ? <CheckCircleOutlined className="aas-sync-ok" /> : null}
                  </div>
                  <InlineNote tone={app.hookInstalled ? 'success' : 'warning'}>
                    {app.hookInstalled
                      ? '已启用。只发送本机刷新通知，不上传账号凭据或聊天正文。'
                      : '尚未启用。启用后只改写该 CLI 的本地 hooks 配置，不影响已运行的会话。'}
                  </InlineNote>
                  {!app.hookInstalled && onInstallHooks ? (
                    <Button
                      icon={<FileTextOutlined />}
                      loading={installingHooks}
                      disabled={busy}
                      onClick={() => onInstallHooks(app.provider)}
                    >
                      启用即时刷新
                    </Button>
                  ) : null}
                  {app.hookInstalled && onUninstallHooks ? (
                    <Button
                      danger
                      loading={installingHooks}
                      disabled={busy}
                      onClick={() => onUninstallHooks(app.provider)}
                    >
                      停用即时刷新
                    </Button>
                  ) : null}
                </section>
              ) : null}
              {loading ? (
                <div className="aas-loading"><Spin tip="正在读取启动权限设置" /></div>
              ) : error && !settings ? (
                <div className="aas-inline-state" data-tone="error" role="alert">
                  <CloseCircleOutlined />
                  <span>{error}</span>
                  <Button size="small" onClick={() => setReloadToken((value) => value + 1)}>重试</Button>
                </div>
              ) : settings && capability ? (
                <>
                  <section className="aas-section">
                    <div className="aas-section-head">
                      <SafetyCertificateOutlined />
                      <div>
                        <strong>aih 启动的 CLI 会话</strong>
                        <span>默认给新开的 aih 会话注入最大权限，不再逐次确认。</span>
                      </div>
                      <Switch
                        checked={settings.maxPermission}
                        disabled={!capability.maxSupported}
                        onChange={(checked) => {
                          setSettings({
                            ...settings,
                            maxPermission: checked,
                            applyToHost: checked ? settings.applyToHost : false
                          });
                          // 关掉最大权限 = 不注入任何权限参数；清空逐项选择，避免界面与实际不一致。
                          if (!checked) setSelections([]);
                        }}
                        aria-label="默认最大权限"
                      />
                    </div>
                    {capability.maxSupported ? (
                      <div className="aas-code-line">
                        <span>启动时自动追加</span>
                        <code>{launchPreview || '（不追加任何权限参数）'}</code>
                      </div>
                    ) : (
                      <div className="aas-inline-state" data-tone="muted">
                        <WarningOutlined />
                        <span>{capability.maxReason || '该应用尚未声明免确认参数，启动时保持原生确认。'}</span>
                      </div>
                    )}
                    <p className="aas-hint">
                      已经显式传入权限参数（例如 <code>--permission-mode</code>）时不会覆盖；
                      登录 / 授权流程也不会注入。
                    </p>
                  </section>

                  {launchPlan ? (
                    <section className="aas-section">
                      <div className="aas-section-head aas-section-head--plain">
                        <SwapOutlined />
                        <div>
                          <strong>启动方式</strong>
                          <span>
                            权限参数与远程 app-server 只能二选一（{resumeBlocked.join(' / ')} 在远程模式下不接受权限覆盖）。
                            这里显示本次实际会怎么启动。
                          </span>
                        </div>
                        <span className="aas-plan-badge" data-mode={launchPlan.mode}>
                          {launchPlan.mode === 'local'
                            ? '本地回退'
                            : launchPlan.mode === 'remote-host'
                              ? '远程 · 宿主配置'
                              : '远程'}
                        </span>
                      </div>
                      <div className="aas-plan-line">{launchPlan.reason}</div>
                      {launchPlan.injected.length ? (
                        <div className="aas-code-line">
                          <span>本次注入</span>
                          <code>{launchPlan.injected.join(' ')}</code>
                        </div>
                      ) : null}
                      {launchPlan.mode === 'local' ? (
                        <div className="aas-plan-actions">
                          <Tooltip
                            title={!capability.hostSupported
                              ? (capability.hostReason || '该应用不支持写入宿主配置')
                              : customArgs.length
                                ? '逐项参数无法写入宿主配置；先改用默认最大权限。'
                                : !hostUsable
                                  ? hostStateText(capability)
                                  : ''}
                          >
                            <span>
                              <Button
                                size="small"
                                disabled={!hostUsable || customArgs.length > 0}
                                onClick={() => setSettings({ ...settings, applyToHost: true })}
                              >
                                写入宿主配置并保持远程
                              </Button>
                            </span>
                          </Tooltip>
                          {customArgs.length ? (
                            <Button
                              size="small"
                              onClick={() => {
                                setSelections([]);
                                setSettings({ ...settings, applyToHost: true });
                              }}
                            >
                              改用默认最大权限并写入宿主
                            </Button>
                          ) : null}
                          <span className="aas-plan-line">保存后生效；已在运行的会话不受影响。</span>
                        </div>
                      ) : null}
                    </section>
                  ) : null}

                  <section className="aas-section">
                    <div className="aas-section-head aas-section-head--plain">
                      <FileTextOutlined />
                      <div>
                        <strong>逐项选择权限参数</strong>
                        <span>
                          只选需要的项；互相排斥的项会自动禁用，保存前就会挡住非法组合。
                          不选任何项 = 使用上面的默认最大权限。
                        </span>
                      </div>
                    </div>

                    {!settings.maxPermission ? (
                      <div className="aas-inline-state" data-tone="muted">
                        <InfoCircleOutlined />
                        <span>最大权限关闭时不会注入任何权限参数；打开上面的开关后再逐项挑选。</span>
                      </div>
                    ) : groups.length === 0 ? (
                      <div className="aas-inline-state" data-tone="muted">
                        <InfoCircleOutlined />
                        <span>该应用没有登记可选的权限参数。</span>
                      </div>
                    ) : (
                      <div className="aas-flag-groups">
                        {groups.map((group) => (
                          <div className="aas-flag-group" key={group.key}>
                            <div className="aas-flag-group-title">{group.label}</div>
                            {group.entries.map((entry) => {
                              const selection = selections.find((item) => item.flag === entry.flag);
                              const checked = Boolean(selection);
                              const { options, freeform } = flagValueOptions(entry);
                              const isBlocked = !checked && blocked.has(entry.flag);
                              return (
                                <div
                                  className="aas-flag-row"
                                  key={entry.flag}
                                  data-selected={checked ? 'true' : undefined}
                                  data-blocked={isBlocked ? 'true' : undefined}
                                >
                                  <div className="aas-flag-main">
                                    <div className="aas-flag-head">
                                      <Switch
                                        size="small"
                                        checked={checked}
                                        disabled={isBlocked}
                                        onChange={(value) => toggleFlag(entry, value)}
                                        aria-label={`启用 ${entry.flag}`}
                                      />
                                      <code className="aas-flag-name">{entry.flag}</code>
                                      {entry.aliases.length ? (
                                        <span className="aas-flag-alias">{entry.aliases.join(' ')}</span>
                                      ) : null}
                                      {isBlocked ? (
                                        <Tooltip title="与已选参数互斥">
                                          <span className="aas-flag-blocked">
                                            <WarningOutlined /> 互斥
                                          </span>
                                        </Tooltip>
                                      ) : null}
                                    </div>
                                    <div className="aas-flag-desc">{entry.description}</div>
                                    <div className="aas-flag-meta">
                                      <span className="aas-flag-example"><code>{entry.example}</code></span>
                                      {entry.configEquivalent ? (
                                        <span className="aas-flag-config">
                                          配置等价：<code>{entry.configEquivalent}</code>
                                        </span>
                                      ) : null}
                                    </div>
                                    {entry.note ? <div className="aas-flag-note">{entry.note}</div> : null}
                                  </div>
                                  {checked && (options.length || freeform) ? (
                                    <div className="aas-flag-value">
                                      {options.length ? (
                                        <Select
                                          size="small"
                                          value={selection?.value || undefined}
                                          options={options.map((option) => ({ value: option, label: option }))}
                                          onChange={(value) => changeFlagValue(entry, String(value))}
                                          placeholder="选择取值"
                                          aria-label={`${entry.flag} 的取值`}
                                        />
                                      ) : (
                                        <Input
                                          size="small"
                                          value={selection?.value || ''}
                                          onChange={(event) => changeFlagValue(entry, event.target.value)}
                                          placeholder="取值"
                                          aria-label={`${entry.flag} 的取值`}
                                        />
                                      )}
                                    </div>
                                  ) : null}
                                </div>
                              );
                            })}
                          </div>
                        ))}
                      </div>
                    )}

                    {conflicts.length ? (
                      <div className="aas-inline-state" data-tone="error" role="alert">
                        <CloseCircleOutlined />
                        <span>{conflicts.map((item) => item.message).join('；')}</span>
                      </div>
                    ) : null}

                    {overrides.length ? (
                      <div className="aas-inline-state" data-tone="muted">
                        <InfoCircleOutlined />
                        <span>{overrides.map((item) => item.message).join('；')}</span>
                      </div>
                    ) : null}

                    {missingValues.length ? (
                      <div className="aas-inline-state" data-tone="error" role="alert">
                        <CloseCircleOutlined />
                        <span>
                          {missingValues.map((selection) => selection.flag).join('、')} 还需要填写取值才能保存。
                        </span>
                      </div>
                    ) : null}

                    {selections.length ? (
                      <div className="aas-code-line">
                        <span>保存后的启动命令</span>
                        <code>{exampleCommand}</code>
                      </div>
                    ) : null}
                  </section>

                  <section className="aas-section">
                    <div className="aas-section-head">
                      <FileTextOutlined />
                      <div>
                        <strong>应用到宿主</strong>
                        <span>同时写入 {app.name} 自己的宿主配置，非 aih 启动的应用也会使用。</span>
                      </div>
                      <Switch
                        checked={settings.applyToHost}
                        disabled={!settings.maxPermission || !capability.hostSupported}
                        onChange={(checked) => setSettings({ ...settings, applyToHost: checked })}
                        aria-label="应用到宿主"
                      />
                    </div>
                    <div className="aas-host-state" data-tone={capability.hostSupported ? 'ok' : 'muted'}>
                      {capability.hostSupported ? <CheckCircleOutlined /> : <WarningOutlined />}
                      <span>{hostStateText(capability)}</span>
                    </div>
                    {capability.hostSupported && capability.hostDisplayPath ? (
                      <code className="aas-path" title={capability.hostDisplayPath}>{capability.hostDisplayPath}</code>
                    ) : null}
                  </section>

                  {error ? (
                    <div className="aas-inline-state" data-tone="error" role="alert">
                      <CloseCircleOutlined />
                      <span>{error}</span>
                    </div>
                  ) : null}

                  <footer className="aas-footer">
                    <span>关闭开关后，新会话恢复原生权限确认；已经运行的会话不受影响。</span>
                    <Button
                      type="primary"
                      loading={saving}
                      disabled={conflicts.length > 0 || missingValues.length > 0}
                      onClick={() => void savePermission()}
                    >
                      保存设置
                    </Button>
                  </footer>
                </>
              ) : null}
            </div>
          ) : activeTab === 'preflight' && showPreflightTab ? (
            <div className="aas-config-pane">
              <ClaudePreflightSettings />
            </div>
          ) : activeTab === 'config' && showConfigTab ? (
            <div className="aas-config-pane">
              <ProviderConfigPanel providerId={provider} embedded />
            </div>
          ) : activeTab === 'inspector' && showConfigTab ? (
            <div className="aas-config-pane">
              <ProviderConfigPanel providerId={provider} embedded view="reference" />
            </div>
          ) : activeTab === 'network' ? (
            <div className="aas-config-pane">
              <ProviderNetworkSettings provider={provider} />
            </div>
          ) : null}
          </div>
        </div>
      )}
    </Modal>
  );
}
