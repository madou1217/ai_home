import { Checkbox, Form, Input, Radio, Space } from 'antd';
import { ModalForm } from '@ant-design/pro-components';
import './account-overlays.css';
import { UpstreamErrorRulesEditor } from './UpstreamErrorRulesEditor';

interface EditAccountModalProps {
  open: boolean;
  form: ReturnType<typeof Form.useForm>[0];
  isClaudeCredential: boolean;
  provider?: string;
  /** 只有第三方/自建上游的 API Key 账号才渲染调度规则编辑器（官方地址无可对齐的错误码）。 */
  showRoutingRules: boolean;
  effectiveAuthMode: string;
  credentialModeChanged: boolean;
  onClose: () => void;
  onSubmit: () => Promise<boolean>;
}

export function EditAccountModal({
  open,
  form,
  isClaudeCredential,
  provider,
  showRoutingRules,
  effectiveAuthMode,
  credentialModeChanged,
  onClose,
  onSubmit
}: EditAccountModalProps) {
  return (
    <ModalForm
      title="编辑配置"
      open={open}
      onOpenChange={(visible) => {
        if (!visible) {
          onClose();
          form.resetFields();
        }
      }}
      form={form}
      layout="vertical"
      onFinish={async () => {
        return onSubmit();
      }}
      submitter={{
        searchConfig: {
          submitText: '保存',
          resetText: '取消',
        },
      }}
    >
      {isClaudeCredential ? (
        <Form.Item
          name="authMode"
          label="Claude 认证方式"
          rules={[{ required: true, message: '请选择 Claude 认证方式' }]}
        >
          <Radio.Group className="aih-choice-tiles">
            <Space direction="vertical">
              <Radio value="api-key"><span className="aih-choice-tile-title">ANTHROPIC_API_KEY</span></Radio>
              <Radio value="auth-token"><span className="aih-choice-tile-title">ANTHROPIC_AUTH_TOKEN</span></Radio>
            </Space>
          </Radio.Group>
        </Form.Item>
      ) : null}
      <Form.Item
        name="apiKey"
        label={effectiveAuthMode === 'auth-token' ? 'Auth Token' : '密钥'}
        extra={credentialModeChanged ? '切换认证方式时必须重新输入。' : '如不修改请留空。支持设置密钥以提升并发配额。'}
        rules={credentialModeChanged ? [{ required: true, message: '切换认证方式时请输入密钥' }] : []}
      >
        <Input.Password autoComplete="new-password" placeholder="sk-..." />
      </Form.Item>
      <Form.Item
        name="baseUrl"
        label="接口地址"
        extra="自定义反代或网关地址。如不修改请留空。"
      >
        <Input placeholder="https://api.openai.com/v1" className="aih-mono-input" />
      </Form.Item>
      {showRoutingRules ? <UpstreamErrorRulesEditor provider={provider} /> : null}
      <Form.Item name="clearErrorBlock" valuePropName="checked" style={{ marginTop: 16 }}>
        <Checkbox>余额或权限已恢复，手动清除账号异常阻塞</Checkbox>
      </Form.Item>
    </ModalForm>
  );
}
