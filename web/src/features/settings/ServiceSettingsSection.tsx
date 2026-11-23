import { useEffect, type ComponentProps, type ReactNode } from 'react';
import { Form, Input, InputNumber, Switch } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import InlineNote from '@/components/ui/InlineNote';
import SettingSection, { SettingRow } from '@/components/ui/SettingSection';
import SettingStatusTag from '@/components/ui/SettingStatusTag';
import SaveActionBar from '@/components/ui/SaveActionBar';
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
  onClearUsageFeedback: () => void;
  onClearServerFeedback: () => void;
  onRestartServer: () => void;
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
  onClearUsageFeedback,
  onClearServerFeedback,
  onRestartServer
}: ServiceSettingsSectionProps) {
  const [usageForm] = Form.useForm<UsageFormValues>();
  const [serverForm] = Form.useForm<ServerConfig>();

  const usageDraft = Form.useWatch([], usageForm);
  const serverDraft = Form.useWatch([], serverForm);

  useEffect(() => {
    usageForm.setFieldsValue(savedUsage);
  }, [savedUsage, usageForm]);

  useEffect(() => {
    serverForm.setFieldsValue({
      ...savedServer,
      apiKey: '',
      managementKey: ''
    });
  }, [savedServer, serverForm]);

  const usageDirty = isUsageFormDirty(usageDraft, savedUsage);
  const serverDirty = isServerFormDirty(serverDraft, savedServer);
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
    serverForm.setFieldsValue({ ...savedServer, apiKey: '', managementKey: '' });
    onClearServerFeedback();
  };

  const handleClearProxy = async () => {
    try {
      const values = await serverForm.validateFields();
      await onSaveServer({ ...values, proxyUrl: '' });
    } catch (_error) {
      // 表单校验会自行提示
    }
  };

  const serverEffectSummary = listenerDraftChanged
    ? '监听地址/端口保存后需点击“一键重启服务”生效'
    : restartRequired
      ? '已保存新的监听配置，点击“一键重启服务”后生效'
      : '代理池保存后立即生效；监听与端口需重启生效';

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
        onFinish={(values) => { void onSaveServer(values); }}
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
            caveat="留空保持当前密钥不变，提交后不回显明文。"
            layout="stacked"
            control={
              <Form.Item name="apiKey">
                <Input.Password
                  id="server-api-key"
                  autoComplete="new-password"
                  placeholder="输入新的 API Key（留空保留原配置）"
                />
              </Form.Item>
            }
          />

          <SettingRow
            title="Management Key"
            htmlFor="server-management-key"
            description="管理端连接当前 Server 所需的密钥。"
            caveat="留空保持当前密钥不变；轮换后会同步更新当前默认 Server 凭据。"
            layout="stacked"
            control={
              <Form.Item name="managementKey">
                <Input.Password
                  id="server-management-key"
                  autoComplete="new-password"
                  placeholder="输入新的 Management Key（留空保留原配置）"
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
