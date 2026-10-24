import { Button, Form, Input, Modal, Radio, Select, Space, Switch, Tag } from 'antd';
import ProviderIcon from '@/components/chat/ProviderIcon';
import { InlineNote } from '@/components/ui/InlineNote';
import {
  PROVIDER_AUTH_OPTIONS,
  getProviderSiteLabel,
  providerFamilies,
} from '@/providers/catalog';
import type { Provider } from '@/types';
import { getAuthOptionValue, splitAuthOptionValue } from '@/features/accounts/auth-option-value';
import './account-overlays.css';

interface AddAccountModalProps {
  open: boolean;
  form: ReturnType<typeof Form.useForm>[0];
  submitting: boolean;
  onSubmit: (values: any) => void;
  onCancel: () => void;
  /**
   * 从本机登录态直接建账号（不走登录任务）。非 null 时渲染一行紧凑入口；
   * 该不该给由服务端认证来源链决定（来源可用 + 能直接提交），弹窗不判断 provider 名。
   */
  localImport?: {
    sourceId: string;
    description: string;
    submitting: boolean;
    onImport: () => void;
  } | null;
  /** 外部账号插件提供的交互登录入口（account.login）。 */
  pluginLogin?: {
    sourceId: string;
    description: string;
    submitting: boolean;
    onLogin: () => void;
  } | null;
}

export function AddAccountModal({
  open,
  form,
  submitting,
  onSubmit,
  onCancel,
  localImport,
  pluginLogin
}: AddAccountModalProps) {
  const selectedProvider = Form.useWatch('provider', form) as Provider | undefined;
  const selectedAuth = splitAuthOptionValue(Form.useWatch('authMode', form));
  const selectedAuthMode = selectedAuth.authMode;
  const providerAuthOptions = selectedProvider
    ? (PROVIDER_AUTH_OPTIONS[selectedProvider] || [])
    : [];

  return (
    <Modal
      title="添加新账号"
      open={open}
      onOk={() => form.submit()}
      onCancel={onCancel}
      confirmLoading={submitting}
      okText="确定"
      cancelText="取消"
      width={600}
    >
      <Form
        form={form}
        layout="vertical"
        onFinish={onSubmit}
      >
        <Form.Item
          name="provider"
          label="供应商"
          rules={[{ required: true, message: '请选择供应商' }]}
        >
          {/* 多站点产品（qoder / codebuddy / workbuddy）合并成一个分组，站点是组内
              的二级选项——因为国内站与国际站账号体系不互通，必须由用户显式选站点；
              表单值始终是真实 Provider ID，提交链路不因合并而改变。 */}
          <Select placeholder="选择供应商" size="large">
            {providerFamilies.map((group) => (group.multiSite ? (
              <Select.OptGroup key={group.family} label={group.label}>
                {group.providers.map((entry) => (
                  <Select.Option key={entry.id} value={entry.id}>
                    <Space align="center">
                      <ProviderIcon provider={entry.id} size={18} />
                      <span>{group.label}</span>
                      <Tag bordered={false} style={{ marginInlineEnd: 0 }}>
                        {getProviderSiteLabel(entry.site)}
                      </Tag>
                    </Space>
                  </Select.Option>
                ))}
              </Select.OptGroup>
            ) : (
              <Select.Option key={group.providers[0].id} value={group.providers[0].id}>
                <Space align="center">
                  <ProviderIcon provider={group.providers[0].id} size={18} />
                  <span>{group.label}</span>
                </Space>
              </Select.Option>
            )))}
          </Select>
        </Form.Item>

        {selectedProvider ? (
          <Form.Item
            name="authMode"
            label="认证方式"
            rules={[{ required: true, message: '请选择认证方式' }]}
          >
            <Radio.Group size="large" className="aih-choice-tiles">
              <Space direction="vertical">
                {providerAuthOptions.map((option) => (
                  <Radio
                    key={getAuthOptionValue(option)}
                    value={getAuthOptionValue(option)}
                    disabled={Boolean(option.disabled)}
                  >
                    <Space direction="vertical" size={0}>
                      <Space align="center" size={6}>
                        <span className="aih-choice-tile-title">{option.label}</span>
                        {option.disabled && (
                          <Tag color="default" bordered={false} style={{ marginInlineEnd: 0 }}>
                            已停用
                          </Tag>
                        )}
                      </Space>
                      <span className="aih-choice-tile-desc">
                        {option.disabledReason || option.description}
                      </span>
                    </Space>
                  </Radio>
                ))}
              </Space>
            </Radio.Group>
          </Form.Item>
        ) : null}

        {localImport ? (
          <div style={{ marginBottom: 16 }}>
            <Space size={8} align="center" wrap>
              <Button size="small" loading={localImport.submitting} onClick={localImport.onImport}>
                从本机导入
              </Button>
              <span className="aih-overlay-hint">
                {localImport.description || '本机已检测到该客户端的登录态，可直接建账号'}
              </span>
            </Space>
          </div>
        ) : null}

        {pluginLogin ? (
          <div style={{ marginBottom: 16 }}>
            <Space size={8} align="center" wrap>
              <Button size="small" loading={pluginLogin.submitting} onClick={pluginLogin.onLogin}>
                插件登录
              </Button>
              <span className="aih-overlay-hint">
                {pluginLogin.description || '该供应商由外部账号插件提供登录流程'}
              </span>
            </Space>
          </div>
        ) : null}

        {selectedAuthMode === 'api-key' || selectedAuthMode === 'auth-token' ? (
          <>
            <Form.Item
              name="apiKey"
              label={
                selectedAuthMode === 'auth-token'
                  ? 'Auth Token'
                  : selectedProvider === 'gemini'
                  ? 'Gemini API Key'
                  : selectedProvider === 'opencode'
                  ? 'OpenCode API Key'
                  : '密钥'
              }
              rules={[{ required: true, message: '请输入密钥' }]}
              help={
                selectedProvider === 'gemini'
                  ? '填入 Google AI Studio 获取的 GEMINI_API_KEY 或 GOOGLE_API_KEY'
                  : selectedProvider === 'opencode'
                  ? '填入 https://opencode.ai/auth 获取的 API Key'
                  : undefined
              }
            >
              <Input.Password
                autoComplete="new-password"
                placeholder={selectedProvider === 'opencode' ? 'sk-...' : '请输入密钥'}
                size="large"
              />
            </Form.Item>

            {selectedProvider !== 'gemini' && (
              <Form.Item
                name="baseUrl"
                label="接口地址（可选）"
                help={
                  selectedProvider === 'opencode'
                    ? '默认使用 OpenCode Go 端点 https://opencode.ai/zen/go/v1，支持全量 Zen / Go 模型；亦可指定 Zen 端点 https://opencode.ai/zen/v1 或自定义反代'
                    : '用于中转服务或自定义网关'
                }
              >
                <Input
                  placeholder={selectedProvider === 'opencode' ? 'https://opencode.ai/zen/go/v1' : 'https://api.example.com'}
                  size="large"
                />
              </Form.Item>
            )}
          </>
        ) : null}

        {/* 别名选号偏好：默认参与；关掉后这个新账号不会被全局别名的自动选号拉进候选池，
            但仍可被账号位显式启动或手动选择。服务端在建账号时立即落库。 */}
        <Form.Item
          name="aliasPoolParticipates"
          label="进入别名自动选号池"
          valuePropName="checked"
          initialValue
          extra="关闭后仍可用账号位显式启动或手动选择；创建后也可在账号菜单「别名选号」里改。"
        >
          <Switch checkedChildren="参与" unCheckedChildren="不参与" />
        </Form.Item>

        {selectedAuthMode === 'vertex-ai' ? (
          <>
            <InlineNote
              tone="info"
              className="add-account-note"
              description="Google Cloud Vertex AI 认证暂未接入真实账号验证。提交后将创建占位账号记录，为后续接入打好基础。"
            >
              Vertex AI 占位模式
            </InlineNote>
            <Form.Item
              name="projectId"
              label="GCP Project ID"
              rules={[{ required: true, message: '请输入 Google Cloud Project ID' }]}
              initialValue="vertex-placeholder-project"
            >
              <Input placeholder="例如：my-gcp-project-123456" size="large" />
            </Form.Item>

            <Form.Item
              name="location"
              label="Region / Location"
              rules={[{ required: true, message: '请输入 Region / Location' }]}
              initialValue="us-central1"
            >
              <Input placeholder="例如：us-central1" size="large" />
            </Form.Item>

            <Form.Item
              name="apiKey"
              label="Service Account 凭据 / API Key（可选）"
              help="服务账号密钥 JSON 或 Vertex API Key（可选占位）"
            >
              <Input.Password autoComplete="new-password" placeholder="可选凭据" size="large" />
            </Form.Item>
          </>
        ) : null}
      </Form>
    </Modal>
  );
}
