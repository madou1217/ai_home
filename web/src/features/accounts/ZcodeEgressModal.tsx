import { useCallback, useEffect, useMemo, useState } from 'react';
import { ImportOutlined, RetweetOutlined, SettingOutlined } from '@ant-design/icons';
import { Button, Form, Input, Modal, Radio, Select, Space, Spin, Tag, Typography, message } from 'antd';
import ProxyImportModal from '@/components/toolkit/proxy-pool/ProxyImportModal';
import { accountsAPI, proxyPoolAPI } from '@/services/api';
import { getAccountPrimaryLabel } from '@/features/accounts/AccountBadges';
import type {
  Account,
  AccountEgressApplyResult,
  AccountEgressMode,
  AccountEgressRotateResponse,
  AccountEgressRuntimeStatus,
  ProxyGroup,
  ProxyNode,
  ProxyNodesResponse
} from '@/types';
import { ZcodeProxyGroupManagerModal } from './ZcodeProxyGroupManagerModal';
import {
  ZCODE_SIDECAR_PROTOCOLS,
  describeApplyResult,
  describeRuntimeStatus,
  formatProxyGroupLabel,
  formatProxyNodeLabel
} from './zcode-egress-presentation';

interface AccountEgressFormValues {
  mode: AccountEgressMode;
  proxyUrl?: string;
  nodeId?: string;
  groupId?: string;
}

interface AccountEgressModalProps {
  account: Account | null;
  onClose: () => void;
}

export function AccountEgressModal({ account, onClose }: AccountEgressModalProps) {
  const [form] = Form.useForm<AccountEgressFormValues>();
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [nodes, setNodes] = useState<ProxyNode[]>([]);
  const [groups, setGroups] = useState<ProxyGroup[]>([]);
  const [nodesUnavailable, setNodesUnavailable] = useState(false);
  const [hasBinding, setHasBinding] = useState(false);
  const [applyResult, setApplyResult] = useState<AccountEgressApplyResult | null>(null);
  const [runtime, setRuntime] = useState<AccountEgressRuntimeStatus | null>(null);
  const [runtimeError, setRuntimeError] = useState('');
  const [rotating, setRotating] = useState(false);
  const [groupManagerOpen, setGroupManagerOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const mode = Form.useWatch('mode', form) || 'url';
  const selectedGroupId = Form.useWatch('groupId', form) || '';
  const usesNativeSettings = account?.provider === 'zcode';

  const applyNodeLibrary = useCallback((response: ProxyNodesResponse) => {
    setNodes((response.nodes || []).filter((node) => (
      ZCODE_SIDECAR_PROTOCOLS.has(node.protocol)
    )));
    setGroups((response.groups || []).filter((group) => group.id !== 'dedicated'));
    setNodesUnavailable(false);
  }, []);

  const markNodeLibraryUnavailable = useCallback(() => {
    setNodes([]);
    setGroups([]);
    setNodesUnavailable(true);
  }, []);

  const refreshNodeLibrary = useCallback(async () => {
    try {
      applyNodeLibrary(await proxyPoolAPI.listNodes());
    } catch {
      markNodeLibraryUnavailable();
    }
  }, [applyNodeLibrary, markNodeLibraryUnavailable]);

  useEffect(() => {
    if (!account) {
      setGroupManagerOpen(false);
      setImportOpen(false);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    setNodesUnavailable(false);
    setApplyResult(null);
    setRuntime(null);
    setRuntimeError('');
    setGroupManagerOpen(false);
    setImportOpen(false);
    form.setFieldsValue({
      mode: 'url',
      proxyUrl: '',
      nodeId: undefined,
      groupId: undefined
    });

    void Promise.allSettled([
      accountsAPI.getAccountEgress(account.provider, account.accountRef),
      proxyPoolAPI.listNodes()
    ]).then(([bindingResult, nodesResult]) => {
      if (cancelled) return;
      if (bindingResult.status === 'fulfilled') {
        const binding = bindingResult.value.binding;
        setHasBinding(Boolean(binding));
        setRuntime(bindingResult.value.runtime || null);
        setRuntimeError(bindingResult.value.runtimeError || '');
        if (binding) {
          form.setFieldsValue({
            mode: binding.mode,
            proxyUrl: binding.proxyUrl || '',
            nodeId: binding.nodeId || undefined,
            groupId: binding.groupId || undefined
          });
        }
      } else {
        setHasBinding(false);
        message.error('读取账号出口绑定失败');
      }

      if (nodesResult.status === 'fulfilled') {
        applyNodeLibrary(nodesResult.value);
      } else {
        markNodeLibraryUnavailable();
      }
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [account, applyNodeLibrary, form, markNodeLibraryUnavailable]);

  const nodeOptions = useMemo(() => nodes.map((node) => ({
    value: node.id,
    label: formatProxyNodeLabel(node)
  })), [nodes]);

  const groupOptions = useMemo(() => groups
    .filter((group) => group.count > 0)
    .map((group) => ({
      value: group.id,
      label: formatProxyGroupLabel(group)
    })), [groups]);
  const selectedGroup = useMemo(
    () => groups.find((group) => group.id === selectedGroupId) || null,
    [groups, selectedGroupId]
  );
  const runtimeNode = useMemo(
    () => nodes.find((node) => node.id === runtime?.selectedNodeId) || null,
    [nodes, runtime?.selectedNodeId]
  );
  const runtimeGroup = useMemo(
    () => groups.find((group) => group.id === runtime?.groupId) || null,
    [groups, runtime?.groupId]
  );

  const updateRuntime = (response: {
    runtime?: AccountEgressRuntimeStatus | null;
    runtimeError?: string;
  }) => {
    if (Object.prototype.hasOwnProperty.call(response, 'runtime')) {
      setRuntime(response.runtime || null);
    }
    setRuntimeError(response.runtimeError || '');
  };

  const reportApplyResult = (apply: AccountEgressApplyResult | undefined, cleared = false) => {
    setApplyResult(apply || null);
    if (apply && !apply.ok) {
      message.warning(cleared ? '绑定已解除，但运行中出口切换失败' : '绑定已保存，但运行中出口切换失败');
      return;
    }
    if (!apply?.applied || apply.status === 'pending_launch') {
      message.success(cleared ? '绑定已解除，将在下次启动时恢复原生设置' : '绑定已保存，将在下次启动时应用');
      return;
    }
    message.success(cleared ? '绑定已解除并已实时应用' : '账号出口已实时应用');
  };

  const saveBinding = async () => {
    if (!account || submitting) return;
    let values: AccountEgressFormValues;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    const binding = {
      mode: values.mode,
      proxyUrl: String(values.proxyUrl || '').trim(),
      nodeId: String(values.nodeId || '').trim(),
      groupId: String(values.groupId || '').trim()
    };
    setSubmitting(true);
    try {
      const response = await accountsAPI.saveAccountEgress(account.provider, account.accountRef, binding);
      setHasBinding(Boolean(response.binding));
      updateRuntime(response);
      reportApplyResult(response.apply);
    } catch (error: any) {
      message.error(error?.response?.data?.error || error?.message || '保存账号出口失败');
    } finally {
      setSubmitting(false);
    }
  };

  const clearBinding = async () => {
    if (!account || submitting) return;
    setSubmitting(true);
    try {
      const response = await accountsAPI.saveAccountEgress(account.provider, account.accountRef, null);
      setHasBinding(false);
      updateRuntime(response);
      form.setFieldsValue({ mode: 'url', proxyUrl: '', nodeId: undefined, groupId: undefined });
      reportApplyResult(response.apply, true);
    } catch (error: any) {
      message.error(error?.response?.data?.error || error?.message || '解除账号出口绑定失败');
    } finally {
      setSubmitting(false);
    }
  };

  const rotateGroupNode = async () => {
    if (!account || rotating || submitting || !runtime?.canRotate) return;
    setRotating(true);
    try {
      const response = await accountsAPI.rotateAccountEgress(account.provider, account.accountRef);
      updateRuntime(response);
      setApplyResult(response);
      message.success('已切换到新的分组节点，账号固定本地端口保持不变');
    } catch (error: any) {
      const response = error?.response?.data as AccountEgressRotateResponse | undefined;
      if (response) {
        updateRuntime(response);
        setApplyResult(response);
      }
      if (response?.rolledBack) {
        message.warning('替代节点均不可用，已恢复原节点、租约和账号进程归属');
      } else {
        message.error(response?.error || error?.message || '切换账号代理节点失败');
      }
    } finally {
      setRotating(false);
    }
  };

  const handleGroupsChanged = (nextGroups: ProxyGroup[], preferredGroupId?: string) => {
    const availableGroups = nextGroups.filter((group) => group.id !== 'dedicated');
    setGroups(availableGroups);
    if (preferredGroupId) {
      form.setFieldValue('groupId', preferredGroupId);
      return;
    }
    const currentGroupId = String(form.getFieldValue('groupId') || '');
    if (currentGroupId && !availableGroups.some((group) => group.id === currentGroupId)) {
      form.setFieldValue('groupId', undefined);
    }
  };

  const applyDescription = describeApplyResult(applyResult);
  const runtimeDescription = describeRuntimeStatus(runtime);

  return (
    <>
      <Modal
        open={Boolean(account)}
        title={account ? `出口设置 · ${getAccountPrimaryLabel(account)}` : '账号出口设置'}
        width={720}
        destroyOnHidden
        maskClosable={!submitting && !rotating}
        onCancel={onClose}
        footer={[
          <Button
            key="clear"
            danger
            disabled={!hasBinding || loading || rotating}
            loading={submitting}
            onClick={() => void clearBinding()}
          >
            解除绑定
          </Button>,
          <Button key="cancel" disabled={submitting || rotating} onClick={onClose}>
            关闭
          </Button>,
          <Button
            key="save"
            type="primary"
            loading={submitting}
            disabled={loading || rotating}
            onClick={() => void saveBinding()}
          >
            保存并应用
          </Button>
        ]}
      >
        <Spin spinning={loading}>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
          当前仅支持 macOS。AIH 使用独立 sing-box sidecar，并为每个账号保持固定的
          127.0.0.1 本地端口；它不会改写系统代理，也不会创建或接管 TUN。系统代理和外部 TUN
          模式都只读取当前状态。订阅地址、YAML 与单节点链接继续在节点库中导入，账号出口只消费
          解析后的节点，不启动其它代理核心。未绑定账号不会继承其它账号或宿主进程的代理环境。
        </Typography.Paragraph>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
          AIH 仅访问中性连通性地址，不调用 ZCode 接口，也不调用其它 provider 推理接口。绑定无法解析或连通性探测失败时会
          阻止启动与请求并保留现有设置，不会回退到全局代理或直连。
          绑定记录无法读取或 marker 无法识别时同样阻止启动并保留现有设置，用户手工设置不变。
          {usesNativeSettings
            ? ' ZCode 原生链路中，模型、MCP、命令工具和内置浏览器统一消费账号隔离的 setting.json；用户手工设置会安全合并。'
            : ' 其他 provider 在 CLI、Desktop 和 Gateway 边界注入该账号的回环代理；不修改系统级网络配置。'}
        </Typography.Paragraph>
          <Space wrap size={8} style={{ marginBottom: 16 }}>
            <Button
              size="small"
              icon={<ImportOutlined />}
              disabled={loading || submitting || rotating}
              onClick={() => setImportOpen(true)}
            >
              导入节点或订阅
            </Button>
            <Typography.Text type="secondary">
              只写入中立节点仓；不会启动、重载或停止其它代理核心，也不会更改系统代理或 TUN。
            </Typography.Text>
          </Space>
          <Space wrap size={8} style={{ marginBottom: 12 }}>
            <Tag color={runtime?.dataPlaneReady ? 'success' : 'default'}>
              {runtime?.dataPlaneReady ? '数据面就绪' : '未运行'}
            </Tag>
            <Typography.Text type="secondary">{runtimeDescription}</Typography.Text>
            {runtime?.proxyServer ? <Typography.Text code>{runtime.proxyServer}</Typography.Text> : null}
            {runtimeGroup ? <Tag>{runtimeGroup.name}</Tag> : null}
            {runtimeNode ? <Tag color="blue">{runtimeNode.name}</Tag> : null}
            {runtime?.health.monitoring ? (
              <Tag color={runtime.health.lastError ? 'warning' : 'processing'}>
                健康监测 {runtime.health.consecutiveFailures || 0}/{runtime.health.failureThreshold || 2}
              </Tag>
            ) : null}
            <Button
              size="small"
              icon={<RetweetOutlined />}
              loading={rotating}
              disabled={!runtime?.canRotate || submitting}
              onClick={() => void rotateGroupNode()}
            >
              立即换一个节点
            </Button>
          </Space>
          {runtimeError ? (
            <Typography.Paragraph type="warning" style={{ marginBottom: 12 }}>
              运行态读取失败：{runtimeError}
            </Typography.Paragraph>
          ) : null}
          {runtime?.health.lastError ? (
            <Typography.Paragraph type="warning" style={{ marginBottom: 12 }}>
              最近健康探测：{runtime.health.lastError}
            </Typography.Paragraph>
          ) : null}
          {applyDescription ? (
            <Space size={8} style={{ marginBottom: 16 }}>
              <Tag color={applyDescription.color}>{applyResult?.applied ? '运行时' : '待启动'}</Tag>
              <Typography.Text type={applyResult?.ok || applyResult?.rolledBack ? 'secondary' : 'danger'}>
                {applyDescription.text}
              </Typography.Text>
            </Space>
          ) : null}
          <Form form={form} layout="vertical" initialValues={{ mode: 'url' }}>
          <Form.Item name="mode" label="出口来源">
            <Radio.Group>
              <Space direction="vertical">
                <Radio value="system">现有系统代理（只读复用）</Radio>
                <Radio value="tun">现有外部 TUN（只读复用）</Radio>
                <Radio value="url">单个 HTTP / SOCKS 地址</Radio>
                <Radio value="node">节点库中的单节点</Radio>
                <Radio value="group">节点组自动调度</Radio>
              </Space>
            </Radio.Group>
          </Form.Item>
          {mode === 'system' ? (
            <Typography.Paragraph type="secondary">
              按 HTTPS、HTTP、SOCKS 顺序读取当前系统代理；未配置时拒绝启动，不会修改系统设置。
            </Typography.Paragraph>
          ) : null}
          {mode === 'tun' ? (
            <Typography.Paragraph type="secondary">
              仅在检测到外部 TUN 已激活时使用；AIH 不创建、不启停，也不接管该 TUN。
            </Typography.Paragraph>
          ) : null}
          {mode === 'url' ? (
            <Form.Item
              name="proxyUrl"
              label="代理地址"
              extra="支持 host:port、HTTP(S)、SOCKS4/4a/5；带凭据的地址请先作为单节点导入节点库。"
              rules={[{ required: true, whitespace: true, message: '请输入代理地址' }]}
            >
              <Input placeholder="127.0.0.1:10801" autoComplete="off" />
            </Form.Item>
          ) : null}
          {mode === 'node' ? (
            <Form.Item
              name="nodeId"
              label="代理节点"
              extra="支持 Shadowsocks、VMess、VLESS（含 Reality）、Trojan、Hysteria2、SOCKS5、HTTP(S)。"
              rules={[{ required: true, message: '请选择代理节点' }]}
            >
              <Select
                showSearch
                optionFilterProp="label"
                placeholder={nodesUnavailable ? '节点库加载失败' : '选择一个节点'}
                options={nodeOptions}
                disabled={nodesUnavailable || nodeOptions.length === 0}
              />
            </Form.Item>
          ) : null}
            {mode === 'group' ? (
              <>
                <Form.Item
                  name="groupId"
                  label="代理节点组"
                  extra="按分组策略选择节点，并尽量避免多个账号占用同一节点。"
                  rules={[{ required: true, message: '请选择代理节点组' }]}
                >
                  <Select
                    showSearch
                    optionFilterProp="label"
                    placeholder={nodesUnavailable ? '节点组加载失败' : '选择一个节点组'}
                    options={groupOptions}
                    disabled={nodesUnavailable || groupOptions.length === 0}
                  />
                </Form.Item>
                <Space wrap size={8} style={{ marginBottom: 16 }}>
                  {selectedGroup ? (
                    <>
                      <Tag>常规：{selectedGroup.strategy || 'sticky'}</Tag>
                      <Tag>故障：{selectedGroup.failoverStrategy || 'lowest_latency'}</Tag>
                    </>
                  ) : null}
                  <Button
                    size="small"
                    icon={<SettingOutlined />}
                    disabled={nodesUnavailable}
                    onClick={() => setGroupManagerOpen(true)}
                  >
                    管理手动组与调度策略
                  </Button>
                </Space>
              </>
            ) : null}
          {nodesUnavailable ? (
            <Typography.Text type="warning">
              节点库暂时不可用；仍可使用现有系统代理、外部 TUN 或单个代理地址。
            </Typography.Text>
          ) : null}
          </Form>
        </Spin>
      </Modal>
      <ProxyImportModal
        open={importOpen && Boolean(account)}
        storageOnly
        onClose={() => setImportOpen(false)}
        onImported={refreshNodeLibrary}
      />
      <ZcodeProxyGroupManagerModal
        open={groupManagerOpen}
        nodes={nodes}
        groups={groups}
        preferredGroupId={selectedGroupId || runtime?.groupId || undefined}
        onClose={() => setGroupManagerOpen(false)}
        onChanged={handleGroupsChanged}
      />
    </>
  );
}

// 兼容旧引用；页面和新代码统一使用通用命名。
export const ZcodeEgressModal = AccountEgressModal;
