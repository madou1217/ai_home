import { useEffect, useState } from 'react';
import { Button, Form, Input, Modal, Radio, Space, Spin, Tag, Typography, message } from 'antd';
import { accountsAPI } from '@/services/api';
import { getAccountPrimaryLabel } from '@/features/accounts/AccountBadges';
import type {
  Account,
  AccountEgressApplyResult,
  AccountEgressBinding,
  AccountEgressMode,
  AccountEgressResponse,
  AccountEgressRuntimeStatus
} from '@/types';
import {
  describeApplyResult,
  describeEgressError,
  describeRuntimeStatus,
  isRetiredEgressBinding
} from './zcode-egress-presentation';
import './account-overlays.css';

interface AccountEgressFormValues {
  mode: AccountEgressMode;
  proxyUrl?: string;
}

interface AccountEgressModalProps {
  account: Account | null;
  onClose: () => void;
}

const RUNTIME_LED_CLASS = {
  ready: ' hud-led--ok hud-led--live',
  error: ' hud-led--err',
  idle: ''
} as const;

export function AccountEgressModal({ account, onClose }: AccountEgressModalProps) {
  const [form] = Form.useForm<AccountEgressFormValues>();
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [binding, setBinding] = useState<AccountEgressBinding | null>(null);
  const [applyResult, setApplyResult] = useState<AccountEgressApplyResult | null>(null);
  const [runtime, setRuntime] = useState<AccountEgressRuntimeStatus | null>(null);
  const [runtimeError, setRuntimeError] = useState('');
  const mode = Form.useWatch('mode', form) || 'url';
  const usesNativeSettings = account?.provider === 'zcode';
  const retired = isRetiredEgressBinding(binding);

  const showBinding = (response: AccountEgressResponse) => {
    setBinding(response.binding || null);
    if (Object.prototype.hasOwnProperty.call(response, 'runtime')) setRuntime(response.runtime || null);
    setRuntimeError(response.runtimeError || '');
  };

  useEffect(() => {
    if (!account) return undefined;
    let cancelled = false;
    setLoading(true);
    setBinding(null);
    setApplyResult(null);
    setRuntime(null);
    setRuntimeError('');
    form.setFieldsValue({ mode: 'url', proxyUrl: '' });

    accountsAPI.getAccountEgress(account.provider, account.accountRef)
      .then((response) => {
        if (cancelled) return;
        showBinding(response);
        const current = response.binding;
        if (current && !current.retired) {
          form.setFieldsValue({ mode: current.mode as AccountEgressMode, proxyUrl: current.proxyUrl || '' });
        }
      })
      .catch(() => {
        if (!cancelled) message.error('读取账号出口绑定失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [account, form]);

  const reportApplyResult = (apply: AccountEgressApplyResult | undefined, cleared = false) => {
    setApplyResult(apply || null);
    if (apply && !apply.ok) {
      message.warning(apply.rolledBack ? '新出口不可用，已恢复原绑定' : '出口已保存，但当前不可用');
      return;
    }
    if (apply?.status === 'restarted') {
      message.success('已用新出口重启运行中的桌面实例');
      return;
    }
    message.success(cleared ? '已解除账号出口绑定' : '账号出口已应用');
  };

  const saveBinding = async () => {
    if (!account || submitting) return;
    let values: AccountEgressFormValues;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    setSubmitting(true);
    try {
      const response = await accountsAPI.saveAccountEgress(account.provider, account.accountRef, {
        mode: values.mode,
        proxyUrl: values.mode === 'url' ? String(values.proxyUrl || '').trim() : ''
      });
      showBinding(response);
      reportApplyResult(response.apply);
    } catch (error: any) {
      const code = error?.response?.data?.error;
      message.error(code ? describeEgressError(code) : error?.message || '保存账号出口失败');
    } finally {
      setSubmitting(false);
    }
  };

  const clearBinding = async () => {
    if (!account || submitting) return;
    setSubmitting(true);
    try {
      const response = await accountsAPI.saveAccountEgress(account.provider, account.accountRef, null);
      showBinding(response);
      form.setFieldsValue({ mode: 'url', proxyUrl: '' });
      reportApplyResult(response.apply, true);
    } catch (error: any) {
      const code = error?.response?.data?.error;
      message.error(code ? describeEgressError(code) : error?.message || '解除账号出口绑定失败');
    } finally {
      setSubmitting(false);
    }
  };

  const applyDescription = describeApplyResult(applyResult);
  const runtimeDescription = describeRuntimeStatus(runtime);
  const resolvedEndpoint = runtime?.resolved?.ok ? runtime.resolved.proxyServer : '';

  return (
    <Modal
      open={Boolean(account)}
      title={account ? `出口设置 · ${getAccountPrimaryLabel(account)}` : '账号出口设置'}
      width={640}
      destroyOnHidden
      maskClosable={!submitting}
      onCancel={onClose}
      footer={[
        <Button
          key="clear"
          danger
          disabled={!binding || loading}
          loading={submitting}
          onClick={() => void clearBinding()}
        >
          解除绑定
        </Button>,
        <Button key="cancel" disabled={submitting} onClick={onClose}>
          关闭
        </Button>,
        <Button
          key="save"
          type="primary"
          loading={submitting}
          disabled={loading}
          onClick={() => void saveBinding()}
        >
          保存并应用
        </Button>
      ]}
    >
      <Spin spinning={loading}>
        <Typography.Paragraph type="secondary" className="egress-intro">
          当前仅支持 macOS。AIH 不运行代理内核、不开本地端口：账号直接使用外部 HTTP(S) 代理、当前系统代理或外部 TUN；
          不会改写系统代理，也不会创建或接管 TUN。
        </Typography.Paragraph>
        <Typography.Paragraph type="secondary" className="egress-intro egress-intro--last">
          保存时只访问中性连通性地址探测一次，不调用 ZCode 接口，也不调用其它 provider 推理接口。出口不可用时阻止启动与请求并保留现有设置，
          不会回退到全局代理或直连；绑定记录无法读取或 marker 无法识别时同样阻止启动，用户手工设置不变。
          {usesNativeSettings
            ? ' ZCode 的模型、MCP、命令工具和内置浏览器统一读取账号隔离的 setting.json；用户手工设置会安全合并。'
            : ' 其它 provider 在 CLI、Desktop 和网关请求边界直接使用该代理；外部 TUN 模式下不注入代理。'}
          {' 桌面端正在运行时，保存后会以新出口重启该实例。'}
        </Typography.Paragraph>
        <div className="egress-runtime hud-panel hud-panel--sm">
          <span className={`egress-runtime-state egress-runtime-state--${runtimeDescription.state}`}>
            <span className={`hud-led${RUNTIME_LED_CLASS[runtimeDescription.state]}`} aria-hidden="true" />
            {runtimeDescription.text}
          </span>
          {resolvedEndpoint ? (
            <Typography.Text code className="egress-runtime-endpoint">{resolvedEndpoint}</Typography.Text>
          ) : null}
          {runtime?.desktopRunning ? <Tag>桌面端运行中{runtime.desktopPid ? ` · PID ${runtime.desktopPid}` : ''}</Tag> : null}
        </div>
        {retired ? (
          <Typography.Paragraph type="warning" className="egress-message">
            该账号的出口模式（{binding?.mode === 'group' ? '节点组' : '节点'}）已随 AIH 本地代理端口一起下线，启动会被阻止；
            请改为代理地址、系统代理或外部 TUN 后保存，或解除绑定。
          </Typography.Paragraph>
        ) : null}
        {runtimeError ? (
          <Typography.Paragraph type="warning" className="egress-message">
            运行态读取失败：{runtimeError}
          </Typography.Paragraph>
        ) : null}
        {applyDescription ? (
          <div className="egress-apply">
            <Tag color={applyDescription.color}>{applyDescription.label}</Tag>
            <Typography.Text type={applyResult?.ok || applyResult?.rolledBack ? 'secondary' : 'danger'}>
              {applyDescription.text}
            </Typography.Text>
          </div>
        ) : null}
        <Form form={form} layout="vertical" initialValues={{ mode: 'url' }}>
          <Form.Item name="mode" label="出口来源">
            <Radio.Group className="aih-choice-tiles">
              <Space direction="vertical">
                <Radio value="url"><span className="aih-choice-tile-title">外部 HTTP(S) 代理地址</span></Radio>
                <Radio value="system"><span className="aih-choice-tile-title">现有系统代理（只读复用）</span></Radio>
                <Radio value="tun"><span className="aih-choice-tile-title">现有外部 TUN（只读复用）</span></Radio>
              </Space>
            </Radio.Group>
          </Form.Item>
          {mode === 'system' ? (
            <Typography.Paragraph type="secondary" className="egress-intro">
              按 HTTPS、HTTP 顺序读取当前系统代理；只配置了 SOCKS 或未配置时拒绝启动，不会修改系统设置。
            </Typography.Paragraph>
          ) : null}
          {mode === 'tun' ? (
            <Typography.Paragraph type="secondary" className="egress-intro">
              仅在检测到外部 TUN 已激活时使用：账号直连，由 TUN 接管；AIH 不创建、不启停，也不接管该 TUN。
            </Typography.Paragraph>
          ) : null}
          {mode === 'url' ? (
            <Form.Item
              name="proxyUrl"
              label="代理地址"
              extra="支持 http(s)://host:port 或 host:port；不支持 SOCKS 与带账号密码的地址，需要时请在本机代理客户端开一个 HTTP 端口。"
              rules={[{ required: true, whitespace: true, message: '请输入代理地址' }]}
            >
              <Input placeholder="127.0.0.1:6152" autoComplete="off" className="aih-mono-input" />
            </Form.Item>
          ) : null}
        </Form>
      </Spin>
    </Modal>
  );
}

// 兼容旧引用；页面和新代码统一使用通用命名。
export const ZcodeEgressModal = AccountEgressModal;
