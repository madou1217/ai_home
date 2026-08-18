import { Alert, Form, Input, Modal, Radio, Select, Space, Tag, Typography } from 'antd';
import ProviderIcon, { providerIds, providerNames } from '@/components/chat/ProviderIcon';
import { PROVIDER_AUTH_OPTIONS } from '@/providers/catalog';
import type { AccountAuthMode, Provider } from '@/types';

const { Text } = Typography;

interface AddAccountModalProps {
  open: boolean;
  form: ReturnType<typeof Form.useForm>[0];
  submitting: boolean;
  onSubmit: (values: any) => void;
  onCancel: () => void;
}

export function AddAccountModal({
  open,
  form,
  submitting,
  onSubmit,
  onCancel
}: AddAccountModalProps) {
  const selectedProvider = Form.useWatch('provider', form) as Provider | undefined;
  const selectedAuthMode = Form.useWatch('authMode', form) as AccountAuthMode | undefined;
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
          <Select placeholder="选择供应商" size="large">
            {providerIds.map((provider) => (
              <Select.Option key={provider} value={provider}>
                <Space align="center">
                  <ProviderIcon provider={provider} size={18} />
                  <span>{providerNames[provider]}</span>
                </Space>
              </Select.Option>
            ))}
          </Select>
        </Form.Item>

        {selectedProvider ? (
          <Form.Item
            name="authMode"
            label="认证方式"
            rules={[{ required: true, message: '请选择认证方式' }]}
          >
            <Radio.Group size="large">
              <Space direction="vertical">
                {providerAuthOptions.map((option) => (
                  <Radio
                    key={option.value}
                    value={option.value}
                    disabled={Boolean(option.disabled)}
                  >
                    <Space direction="vertical" size={0}>
                      <Space align="center" size={6}>
                        <span>{option.label}</span>
                        {option.disabled && (
                          <Tag color="default" bordered={false} style={{ fontSize: 11, lineHeight: '18px', padding: '0 6px' }}>
                            已停用
                          </Tag>
                        )}
                      </Space>
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        {option.disabledReason || option.description}
                      </Text>
                    </Space>
                  </Radio>
                ))}
              </Space>
            </Radio.Group>
          </Form.Item>
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

        {selectedAuthMode === 'vertex-ai' ? (
          <>
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 16 }}
              message="Vertex AI 占位模式"
              description="Google Cloud Vertex AI 认证暂未接入真实账号验证。提交后将创建占位账号记录，为后续接入打好基础。"
            />
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