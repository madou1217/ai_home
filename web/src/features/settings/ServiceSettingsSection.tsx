import { useCallback, useEffect, useRef, useState, type ChangeEvent, type ComponentProps, type ReactNode } from 'react';
import { Form, Input, InputNumber, Switch, Tooltip, message } from 'antd';
import type { Rule } from 'antd/es/form';
import { CopyOutlined, ReloadOutlined, SwapOutlined } from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import { configAPI } from '@/services/api';
import { writeClipboardText } from '@/utils/clipboard';
import InlineNote from '@/components/ui/InlineNote';
import SettingSection, { SettingRow } from '@/components/ui/SettingSection';
import SettingStatusTag from '@/components/ui/SettingStatusTag';
import SaveActionBar from '@/components/ui/SaveActionBar';
import {
  MAX_MANAGEMENT_KEY_LENGTH,
  MIN_MANAGEMENT_KEY_LENGTH,
  generateSecureToken
} from '@/services/management-key-rotation';
import Upstream429RetrySettingCard from './Upstream429RetrySettingCard';
import {
  SERVER_FORM_DEFAULTS,
  SERVER_PORT_RULES,
  USAGE_FIELD_RULES,
  USAGE_FORM_DEFAULTS,
  type RestartStateNote,
  type UsageFormValues
} from './settings-config';
import {
  hasListenerChanges,
  isServerFormDirty,
  isUsageFormDirty,
  type FormSaveFeedback
} from './use-settings-data';
import type { ServerConfig } from '@/types';

type NumericAddonInputProps = ComponentProps<typeof InputNumber> & {
  addonAfter: ReactNode;
};

const NumericAddonInput = ({ addonAfter, style, ...props }: NumericAddonInputProps) => (
  <InputNumber {...props} addonAfter={addonAfter} style={{ width: '100%', maxWidth: 200, ...style }} />
);

export interface ServiceSettingsSectionProps {
  loading: boolean;
  loadError: string | null;
  savedUsage: UsageFormValues;
  savedServer: ServerConfig;
  usageSaving: boolean;
  serverSaving: boolean;
  usageFeedback: FormSaveFeedback | null;
  serverFeedback: FormSaveFeedback | null;
  restartRequired: boolean;
  restarting: boolean;
  restartAlert: RestartStateNote | null;
  onReload: () => void;
  onSaveUsage: (values: UsageFormValues) => Promise<UsageFormValues>;
  onSaveServer: (values: ServerConfig) => Promise<ServerConfig>;
  onApplyServerSecret: (field: SecretField, value: string) => Promise<void>;
  onClearUsageFeedback: () => void;
  onClearServerFeedback: () => void;
  onRestartServer: () => void;
}

type SecretField = 'apiKey' | 'managementKey';

interface SecretInputProps {
  id: string;
  value?: string;
  disabled?: boolean;
  placeholder?: string;
  autoComplete?: string;
  onChange?: (event: ChangeEvent<HTMLInputElement>) => void;
  onCopy: (value: string) => void;
  onRotate: () => void;
  rotating?: boolean;
  rotateDisabled?: boolean;
}

/**
 * 密钥输入：眼睛、复制与一键轮换全部收在输入框内部；
 * 复制与轮换常显为纯图标，悬停显示 tooltip。
 */
function SecretInput({
  id,
  value = '',
  disabled,
  placeholder,
  autoComplete,
  onChange,
  onCopy,
  onRotate,
  rotating = false,
  rotateDisabled = false
}: SecretInputProps) {
  return (
    <Input.Password
      id={id}
      value={value}
      disabled={disabled}
      onChange={onChange}
      autoComplete={autoComplete}
      placeholder={placeholder}
      className="hos-secret-input"
      suffix={
        <span className="hos-secret-actions">
          <Tooltip title="复制">
            <Button
              type="text"
              size="small"
              className="hos-secret-icon"
              icon={<CopyOutlined />}
              aria-label="复制密钥"
              disabled={!value}
              onClick={() => { if (value) onCopy(value); }}
            />
          </Tooltip>
          <Tooltip title="一键轮换">
            <Button
              type="text"
              size="small"
              className="hos-secret-icon"
              icon={<SwapOutlined />}
              aria-label="一键轮换"
              loading={rotating}
              disabled={rotateDisabled && !rotating}
              onClick={onRotate}
            />
          </Tooltip>
        </span>
      }
    />
  );
}

function secretPlaceholder(configured: boolean, value: string): string {
  if (value) return '输入新值后保存即完成轮换';
  return configured
    ? '当前值由环境变量提供，无法在此回显；输入新值可覆盖'
    : '尚未设置；输入新值后保存即可启用';
}

function apiKeyCaveat(configured: boolean, value: string): string {
  if (value) return '点击眼睛图标查看明文；输入框内图标可复制或一键轮换。填写新值或轮换后保存，重启服务即对外生效。';
  return configured
    ? '当前值由环境变量提供，无法在界面回显；填写新值保存后会写入配置，重启后生效。'
    : '暂未设置；填写新值保存并重启即可启用。';
}

function managementKeyCaveat(configured: boolean, value: string): string {
  if (value) return '点击眼睛图标查看明文；输入框内图标可复制或一键轮换。填写新值或轮换即完成轮换，并同步更新当前默认 Server 凭据。';
  return configured
    ? '当前值由环境变量提供，无法在界面回显；填写新值保存后会写入配置并同步更新当前默认 Server 凭据。'
    : '暂未设置；填写新值保存即可启用，并同步更新当前默认 Server 凭据。';
}

function summarizeProxyPool(proxyUrl: string | undefined): string {
  const normalized = String(proxyUrl || '').trim();
  if (!normalized) return '直连（未配置代理）';
  const count = normalized.split(/[\n,]+/).map((item) => item.trim()).filter(Boolean).length;
  return `已配置 ${count} 个上游代理`;
}

/**
 * 「服务与调度」区块：上游 429 重试、账号调度阈值与刷新间隔、本地服务监听与代理配置。
 * 每个表单均清晰区分草稿与已保存值，并在底部 SaveActionBar 明确说明生效方式。
 */
export default function ServiceSettingsSection({
  loading,
  loadError,
  savedUsage,
  savedServer,
  usageSaving,
  serverSaving,
  usageFeedback,
  serverFeedback,
  restartRequired,
  restarting,
  restartAlert,
  onReload,
  onSaveUsage,
  onSaveServer,
  onApplyServerSecret,
  onClearUsageFeedback,
  onClearServerFeedback,
  onRestartServer
}: ServiceSettingsSectionProps) {
  const [usageForm] = Form.useForm<UsageFormValues>();
  const [serverForm] = Form.useForm<ServerConfig>();

  const usageDraft = Form.useWatch([], usageForm);
  const serverDraft = Form.useWatch([], serverForm);

  const [serverSecrets, setServerSecrets] = useState({
    apiKey: '',
    managementKey: '',
    apiKeyConfigured: false,
    managementKeyConfigured: false
  });
  const [rotatingSecret, setRotatingSecret] = useState<SecretField | ''>('');
  // 记录已经写进表单的密钥明文，避免刷新时覆盖用户正在输入的新值。
  const appliedSecretRef = useRef({ apiKey: '', managementKey: '' });

  // 明文只在显式请求时取回；用于当前值的眼睛回显与复制，不进入普通配置快照。
  const loadServerSecrets = useCallback(async () => {
    try {
      setServerSecrets(await configAPI.getSecrets());
    } catch {
      // 回显失败不阻塞配置读写，输入框保持占位提示。
    }
  }, []);

  useEffect(() => {
    void loadServerSecrets();
  }, [loadServerSecrets, savedServer.apiKeyConfigured, savedServer.managementKeyConfigured]);

  const copyServerSecret = async (label: string, value: string) => {
    if (!value) return;
    try {
      await writeClipboardText(value);
      message.success(`${label} 已复制`);
    } catch {
      message.error('复制失败，请点击眼睛图标后手动复制');
    }
  };

  useEffect(() => {
    usageForm.setFieldsValue(savedUsage);
  }, [savedUsage, usageForm]);

  // 非密钥字段跟随已保存配置；密钥字段由下面的明文快照同步，避免保存后被清空。
  useEffect(() => {
    serverForm.setFieldsValue({
      host: savedServer.host,
      port: savedServer.port,
      openNetwork: savedServer.openNetwork,
      proxyUrl: savedServer.proxyUrl
    });
  }, [savedServer, serverForm]);

  useEffect(() => {
    const applied = appliedSecretRef.current;
    const draft = serverForm.getFieldsValue(['apiKey', 'managementKey']) as Partial<ServerConfig>;
    const next: Partial<ServerConfig> = {};
    if (String(draft.apiKey ?? '') === applied.apiKey) next.apiKey = serverSecrets.apiKey;
    if (String(draft.managementKey ?? '') === applied.managementKey) next.managementKey = serverSecrets.managementKey;
    if (Object.keys(next).length) serverForm.setFieldsValue(next);
    appliedSecretRef.current = {
      apiKey: serverSecrets.apiKey,
      managementKey: serverSecrets.managementKey
    };
  }, [serverSecrets, serverForm]);

  const usageDirty = isUsageFormDirty(usageDraft, savedUsage);
  const serverDirty = isServerFormDirty(serverDraft, savedServer, serverSecrets);
  const draftOpenNetwork = Boolean(serverDraft?.openNetwork ?? savedServer.openNetwork);
  const listenerDraftChanged = serverDirty && hasListenerChanges(serverDraft || {}, savedServer);
  const hasSavedProxy = Boolean(String(savedServer.proxyUrl || '').trim());

  const usageStatus = usageSaving
    ? 'saving'
    : usageFeedback?.tone === 'error'
      ? 'error'
      : usageDirty
        ? 'dirty'
        : 'applied';

  const serverStatus = serverSaving
    ? 'saving'
    : serverFeedback?.tone === 'error'
      ? 'error'
      : serverDirty
        ? 'dirty'
        : restartRequired
          ? 'pending_restart'
          : 'applied';

  const handleResetUsage = () => {
    usageForm.setFieldsValue(savedUsage);
    onClearUsageFeedback();
  };

  const handleResetServer = () => {
    appliedSecretRef.current = {
      apiKey: serverSecrets.apiKey,
      managementKey: serverSecrets.managementKey
    };
    serverForm.setFieldsValue({
      ...savedServer,
      apiKey: serverSecrets.apiKey,
      managementKey: serverSecrets.managementKey
    });
    onClearServerFeedback();
  };

  // 表单里预填的是当前密钥；只有真正改成新值才提交，留空或未改动都保持原密钥。
  const valuesForServerSave = (values: ServerConfig): ServerConfig => {
    const apiKey = String(values.apiKey || '').trim();
    const managementKey = String(values.managementKey || '').trim();
    return {
      ...values,
      apiKey: apiKey && apiKey !== String(serverSecrets.apiKey || '').trim() ? apiKey : '',
      managementKey: managementKey && managementKey !== String(serverSecrets.managementKey || '').trim()
        ? managementKey
        : ''
    };
  };

  const submitServerValues = async (values: ServerConfig) => {
    const saved = await onSaveServer(valuesForServerSave(values));
    // 保存成功后立即把密钥快照更新为新值，避免表单短暂回退到旧密钥。
    const apiKey = String(values.apiKey || '').trim() || serverSecrets.apiKey;
    const managementKey = String(values.managementKey || '').trim() || serverSecrets.managementKey;
    appliedSecretRef.current = { apiKey, managementKey };
    // 留空保存等于保持原密钥：把输入框恢复成实际生效值，避免显示成空。
    serverForm.setFieldsValue({ apiKey, managementKey });
    setServerSecrets((current) => ({
      apiKey,
      managementKey,
      apiKeyConfigured: Boolean(apiKey) || current.apiKeyConfigured,
      managementKeyConfigured: Boolean(managementKey) || current.managementKeyConfigured
    }));
    void loadServerSecrets();
    return saved;
  };

  const handleClearProxy = async () => {
    try {
      const values = await serverForm.validateFields();
      await submitServerValues({ ...values, proxyUrl: '' });
    } catch (_error) {
      // 表单校验会自行提示
    }
  };

  // 一键轮换：生成随机密钥并立即写入，不触碰表单里其它未保存草稿。
  const rotateSecret = async (field: SecretField) => {
    const label = field === 'apiKey' ? 'API Key' : 'Management Key';
    setRotatingSecret(field);
    try {
      const generated = generateSecureToken();
      await onApplyServerSecret(field, generated);
      appliedSecretRef.current = { ...appliedSecretRef.current, [field]: generated };
      setServerSecrets((current) => (
        field === 'apiKey'
          ? { ...current, apiKey: generated, apiKeyConfigured: true }
          : { ...current, managementKey: generated, managementKeyConfigured: true }
      ));
      serverForm.setFieldValue(field, generated);
      message.success(`${label} 已轮换`);
    } catch {
      // 失败反馈由 onApplyServerSecret 写入 serverFeedback。
    } finally {
      setRotatingSecret('');
    }
  };

  const managementKeyRules: Rule[] = [
    {
      validator: async (_rule, value) => {
        const next = String(value || '').trim();
        if (!next || next === String(serverSecrets.managementKey || '').trim()) return;
        if (
          next.length < MIN_MANAGEMENT_KEY_LENGTH
          || next.length > MAX_MANAGEMENT_KEY_LENGTH
          || /[\r\n\0]/.test(next)
        ) {
          throw new Error(
            `Management Key 必须为 ${MIN_MANAGEMENT_KEY_LENGTH}-${MAX_MANAGEMENT_KEY_LENGTH} 个字符，且不能包含换行。`
          );
        }
      }
    }
  ];

  const serverEffectSummary = listenerDraftChanged
    ? '监听地址/端口保存后需点击“一键重启服务”生效'
    : restartRequired
      ? '有配置需重启才生效，点击“一键重启服务”完成'
      : '代理池与 Management Key 立即生效；API Key、监听与端口需重启生效';

  return (
    <div className="settings-grid">
      <Upstream429RetrySettingCard />

      <Form
        form={usageForm}
        disabled={loading}
        layout="vertical"
        onFinish={(values) => { void onSaveUsage(values); }}
        onValuesChange={() => { if (usageFeedback) onClearUsageFeedback(); }}
        initialValues={USAGE_FORM_DEFAULTS}
        className="settings-section-form"
      >
        <SettingSection
          title="账号调度"
          description="控制自动切号阈值与后台用量刷新周期。"
          status={<SettingStatusTag status={usageStatus} compact />}
          footer={
            <SaveActionBar
              dirty={usageDirty}
              saving={usageSaving}
              disabled={loading}
              htmlType="submit"
              onReset={handleResetUsage}
              status={usageStatus}
              saveLabel="保存调度配置"
              cleanSaveLabel="已应用"
              effectSummary="保存后立即应用到当前 Server 调度器"
              feedback={usageFeedback?.text}
              feedbackTone={usageFeedback?.tone ?? 'muted'}
            />
          }
        >
          {loadError ? (
            <InlineNote
              tone="error"
              className="settings-inline-alert"
              action={<Button size="small" onClick={onReload}>重试读取</Button>}
            >
              {loadError}
            </InlineNote>
          ) : null}

          <SettingRow
            title="自动切换阈值"
            htmlFor="usage-threshold-pct"
            description="已用额度达到此比例时自动切到其他账号，恢复后重新参与调度。"
            persistedValue={`已应用：${savedUsage.threshold_pct}%`}
            control={
              <Form.Item name="threshold_pct" rules={USAGE_FIELD_RULES.threshold_pct}>
                <NumericAddonInput id="usage-threshold-pct" min={0} max={100} addonAfter="%" />
              </Form.Item>
            }
          />

          <SettingRow
            title="活跃刷新间隔"
            htmlFor="usage-active-refresh"
            description="正在处理请求的账号额度查询周期。"
            persistedValue={`已应用：${savedUsage.active_refresh_interval} 秒`}
            control={
              <Form.Item name="active_refresh_interval" rules={USAGE_FIELD_RULES.active_refresh_interval}>
                <NumericAddonInput id="usage-active-refresh" min={10} addonAfter="秒" />
              </Form.Item>
            }
          />

          <SettingRow
            title="后台刷新间隔"
            htmlFor="usage-bg-refresh"
            description="空闲账号的后台额度巡检周期。"
            persistedValue={`已应用：${savedUsage.background_refresh_interval} 秒`}
            control={
              <Form.Item name="background_refresh_interval" rules={USAGE_FIELD_RULES.background_refresh_interval}>
                <NumericAddonInput id="usage-bg-refresh" min={60} addonAfter="秒" />
              </Form.Item>
            }
          />
        </SettingSection>
      </Form>

      <Form
        form={serverForm}
        disabled={loading}
        layout="vertical"
        onFinish={(values) => { void submitServerValues(values); }}
        onValuesChange={() => { if (serverFeedback) onClearServerFeedback(); }}
        initialValues={SERVER_FORM_DEFAULTS}
        className="settings-section-form"
      >
        <SettingSection
          title="服务配置"
          description="管理本地监听地址、接口密钥与上游代理池。"
          status={<SettingStatusTag status={serverStatus} compact />}
          footer={
            <SaveActionBar
              dirty={serverDirty}
              saving={serverSaving}
              disabled={loading}
              htmlType="submit"
              onReset={handleResetServer}
              status={serverStatus}
              saveLabel="保存服务配置"
              cleanSaveLabel={restartRequired ? '已保存·待重启' : '已应用'}
              effectSummary={serverEffectSummary}
              feedback={serverFeedback?.text}
              feedbackTone={serverFeedback?.tone ?? 'muted'}
              extraActions={
                <>
                  {hasSavedProxy ? (
                    <Button onClick={() => void handleClearProxy()} loading={serverSaving}>
                      清除代理
                    </Button>
                  ) : null}
                  <Button
                    type={restartRequired ? 'primary' : 'default'}
                    icon={<ReloadOutlined />}
                    onClick={onRestartServer}
                    loading={restarting}
                  >
                    一键重启服务
                  </Button>
                </>
              }
            />
          }
        >
          {restartAlert ? (
            <InlineNote
              tone={restartAlert.type}
              className="settings-inline-alert settings-restart-alert animate__animated animate__fadeIn animate__faster"
            >
              {restartAlert.message}
            </InlineNote>
          ) : null}

          <SettingRow
            title="开放网络访问"
            htmlFor="server-open-network"
            description="开启后监听 0.0.0.0，允许局域网或远程访问。"
            persistedValue={`已保存：${savedServer.openNetwork ? '开放（0.0.0.0）' : '仅本机'}`}
            caveat="修改监听设置保存后，需点击底部“一键重启服务”生效。"
            control={
              <Form.Item name="openNetwork" valuePropName="checked">
                <Switch id="server-open-network" checkedChildren="开放" unCheckedChildren="本机" />
              </Form.Item>
            }
          />

          <SettingRow
            title="监听地址"
            htmlFor="server-host"
            description={draftOpenNetwork ? '开放网络时固定绑定 0.0.0.0。' : '仅本机访问时默认使用 127.0.0.1。'}
            persistedValue={`已保存：${savedServer.host}`}
            control={
              <Form.Item name="host">
                <Input id="server-host" disabled={draftOpenNetwork} placeholder="127.0.0.1" />
              </Form.Item>
            }
          />

          <SettingRow
            title="监听端口"
            htmlFor="server-port"
            description="本地网关 HTTP 监听端口。"
            persistedValue={`已保存：${savedServer.port}`}
            control={
              <Form.Item name="port" rules={SERVER_PORT_RULES}>
                <InputNumber id="server-port" min={1} max={65535} style={{ width: '100%', maxWidth: 200 }} />
              </Form.Item>
            }
          />

          <SettingRow
            title="API Key"
            htmlFor="server-api-key"
            description="客户端调用 /v1 接口时使用的密钥。"
            caveat={apiKeyCaveat(serverSecrets.apiKeyConfigured, serverSecrets.apiKey)}
            layout="stacked"
            control={
              <Form.Item name="apiKey" className="hos-secret-control-field">
                <SecretInput
                  id="server-api-key"
                  autoComplete="new-password"
                  placeholder={secretPlaceholder(serverSecrets.apiKeyConfigured, serverSecrets.apiKey)}
                  onCopy={(value) => void copyServerSecret('API Key', value)}
                  onRotate={() => void rotateSecret('apiKey')}
                  rotating={rotatingSecret === 'apiKey'}
                  rotateDisabled={loading || serverSaving}
                />
              </Form.Item>
            }
          />

          <SettingRow
            title="Management Key"
            htmlFor="server-management-key"
            description="管理端连接当前 Server 所需的密钥。"
            caveat={managementKeyCaveat(serverSecrets.managementKeyConfigured, serverSecrets.managementKey)}
            layout="stacked"
            control={
              <Form.Item name="managementKey" className="hos-secret-control-field" rules={managementKeyRules}>
                <SecretInput
                  id="server-management-key"
                  autoComplete="new-password"
                  placeholder={secretPlaceholder(serverSecrets.managementKeyConfigured, serverSecrets.managementKey)}
                  onCopy={(value) => void copyServerSecret('Management Key', value)}
                  onRotate={() => void rotateSecret('managementKey')}
                  rotating={rotatingSecret === 'managementKey'}
                  rotateDisabled={loading || serverSaving}
                />
              </Form.Item>
            }
          />

          <SettingRow
            title="上游代理池"
            htmlFor="server-proxy-url"
            description="逗号或换行分隔，按顺序轮询并在失败时自动切换。"
            persistedValue={`已生效：${summarizeProxyPool(savedServer.proxyUrl)}`}
            caveat="保存后立即生效，无需重启；留空表示直连。"
            layout="stacked"
            control={
              <Form.Item name="proxyUrl">
                <Input.TextArea
                  id="server-proxy-url"
                  rows={3}
                  placeholder="socks5://127.0.0.1:1080, http://user:pass@host:8080"
                />
              </Form.Item>
            }
          />
        </SettingSection>
      </Form>
    </div>
  );
}
