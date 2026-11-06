import { useEffect, useState } from 'react';
import { Button, Checkbox, Form, Input, Radio, Space, Tabs } from 'antd';
import { ModalForm } from '@ant-design/pro-components';
import type { Account } from '@/types';
import './account-overlays.css';
import { AccountConfigFilesPanel } from './AccountConfigFilesModal';
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
  /** 正在编辑的账号：提供后追加只读「配置文件」Tab，并把导出收进同一个弹窗。 */
  account?: Account | null;
  onExport?: () => void;
  exporting?: boolean;
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
  account,
  onExport,
  exporting,
  onClose,
  onSubmit
}: EditAccountModalProps) {
  const [activeTab, setActiveTab] = useState('credential');
  // 每次重新打开回到凭据 Tab：上次停在「配置文件」不意味着这次也要看文件。
  useEffect(() => {
    if (open) setActiveTab('credential');
  }, [open]);
  const closeAndReset = () => {
    onClose();
    form.resetFields();
  };
  // 可编辑项按用途分组，弹窗不再一路平铺到底。
  // forceRender 必须开：隐藏 Tab 里的 Form.Item 也要挂载，否则「切换认证方式后密钥必填」
  // 这类校验在提交时会被跳过。
  const tabItems = [
    {
      key: 'credential',
      label: '凭据',
      forceRender: true,
      children: (
        <>
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
        </>
      )
    },
    ...(showRoutingRules ? [{
      key: 'routing',
      label: '调度规则',
      forceRender: true,
      children: <UpstreamErrorRulesEditor provider={provider} />
    }] : []),
    {
      key: 'blocking',
      label: '异常阻塞',
      forceRender: true,
      children: (
        <Form.Item name="clearErrorBlock" valuePropName="checked">
          <Checkbox>余额或权限已恢复，手动清除账号异常阻塞</Checkbox>
        </Form.Item>
      )
    },
    // 配置文件与导出都是「看这台账号的配置」，和编辑放在同一弹窗里，菜单不再各占一行。
    ...(account ? [{
      key: 'files',
      label: '配置文件',
      children: (
        <AccountConfigFilesPanel account={account} onExport={onExport} exporting={exporting} />
      )
    }] : [])
  ];

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
      // 调度规则编辑器的规则表与配置文件编辑器都需要 960px；没有这些 Tab 时保持紧凑。
      width={showRoutingRules || account ? 960 : 600}
      onFinish={async () => {
        return onSubmit();
      }}
      submitter={activeTab === 'files' ? {
        // 配置文件 Tab 是只读的：此时不提供「保存」，避免误提交凭据表单。
        render: () => [<Button key="close" onClick={closeAndReset}>关闭</Button>],
      } : {
        searchConfig: {
          submitText: '保存',
          resetText: '取消',
        },
      }}
    >
      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        items={tabItems}
      />
    </ModalForm>
  );
}
