import { Form, Input, Modal, Radio, Select, Space, Tag } from 'antd';
import ProviderIcon from '@/components/chat/ProviderIcon';
import { InlineNote } from '@/components/ui/InlineNote';
import {
  PROVIDER_AUTH_OPTIONS,
  getProviderSiteLabel,
  providerFamilies,
} from '@/providers/catalog';
import type { AccountAuthMode, Provider } from '@/types';
import './account-overlays.css';

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
                    key={option.value}
                    value={option.value}
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