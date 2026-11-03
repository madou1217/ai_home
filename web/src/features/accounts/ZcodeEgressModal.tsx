import { useEffect, useState, type ReactNode } from 'react';
import { Button, Form, Input, Modal, Popover, Radio, Space, Spin, Tag, Typography, message } from 'antd';
import InlineNote from '@/components/ui/InlineNote';
import PoolScopePicker, { type PoolSelection } from '@/features/egress-upstream/PoolScopePicker';
import { egressUpstreamAPI } from '@/features/egress-upstream/egress-upstream-api';
import { applyEgressToAccounts } from '@/features/egress-upstream/bulk-egress';
import { sameUpstreamUnbound } from '@/features/egress-upstream/egress-upstream-presentation';
import type { EgressUpstreamView } from '@/features/egress-upstream/types';
import { ApiOutlined, InfoCircleOutlined } from '@ant-design/icons';
import { history } from '@umijs/max';
import { accountsAPI } from '@/services/api';
import { getAccountPrimaryLabel } from '@/features/accounts/AccountBadges';
import AccountEgressRuntimePanel from './AccountEgressRuntimePanel';
import type {
  Account,
  AccountEgressApplyResult,
  AccountEgressBinding,
  AccountEgressBindingInput,
  AccountEgressMode,
  AccountEgressResponse,
  AccountEgressRuntimeStatus
} from '@/types';
import type { AccountEgressRuntimeView } from '@/types';
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

const DEFAULT_POOL_SELECTION: PoolSelection = { scope: { kind: 'all', groups: [], nodes: [] }, strategy: 'shared' };

const RUNTIME_LED_CLASS = {
  ready: ' hud-led--ok hud-led--live',
  error: ' hud-led--err',
  idle: ''
} as const;

/**
 * 说明气泡：默认收起的 info 图标，点击才展开。
 *
 * 为什么不做成常驻段落：这些内容（平台限制、探测语义、各来源的行为）对**已经知道**的
 * 用户是纯噪音，而这个弹窗的日常操作只是「选一个来源 + 填地址 + 保存」。按选项挂载
 * 说明，谁需要谁点开，弹窗本体保持可一眼扫完。
 *
 * 图标内嵌在 Radio 的 label 里（antd 的 .ant-radio-wrapper 就是 label），点击会冒泡成
 * 「选中该项」——所以这里必须 preventDefault + stopPropagation：看说明不该改变用户的选择。
 */
function EgressHint({ title, children }: { title: string; children: ReactNode }) {
  // 受控打开：span 不会因 Enter/Space 合成 click，键盘用户必须由这里显式切换。
  const [open, setOpen] = useState(false);
  const swallow = (event: { preventDefault: () => void; stopPropagation: () => void }) => {
    event.preventDefault();
    event.stopPropagation();
  };
  return (
    <Popover
      title={title}
      content={<div className="egress-hint">{children}</div>}
      trigger={['click']}
      open={open}
      onOpenChange={setOpen}
      // 向下展开、右对齐到图标：弹窗靠右时 rightTop 会冲出视口；autoAdjustOverflow 在底部空间
      // 不够时自动翻到上方。宽度封顶在视口内（见 .egress-hint-popover），长内容换行而不是被裁掉。
      placement="bottomRight"
      autoAdjustOverflow
      arrow={{ pointAtCenter: true }}
      getPopupContainer={() => document.body}
      overlayClassName="egress-hint-popover"
    >
      <span
        className="egress-hint-trigger"
        role="button"
        tabIndex={0}
        aria-label={`${title}说明`}
        aria-expanded={open}
        onClick={swallow}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            if (open) swallow(event);
            setOpen(false);
            return;
          }
          if (event.key !== 'Enter' && event.key !== ' ') return;
          swallow(event);
          setOpen((current) => !current);
        }}
      >
        <InfoCircleOutlined />
      </span>
    </Popover>
  );
}

export function AccountEgressModal({ account, onClose }: AccountEgressModalProps) {
  const [form] = Form.useForm<AccountEgressFormValues>();
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [binding, setBinding] = useState<AccountEgressBinding | null>(null);
  const [applyResult, setApplyResult] = useState<AccountEgressApplyResult | null>(null);
  const [runtime, setRuntime] = useState<AccountEgressRuntimeStatus | null>(null);
  const [runtimeError, setRuntimeError] = useState('');
  const [accountRuntimeView, setAccountRuntimeView] = useState<AccountEgressRuntimeView | null>(null);
  const mode = Form.useWatch('mode', form) || 'url';
  // 上游判定（节点能否访问该账号的上游、当前网络是否被拒）与出口池节点范围。
  const [upstreamView, setUpstreamView] = useState<EgressUpstreamView | null>(null);
  const [poolSelection, setPoolSelection] = useState<PoolSelection>(DEFAULT_POOL_SELECTION);
  const [probing, setProbing] = useState(false);
  const upstream = upstreamView?.upstreams[0] || null;
  const upstreamAccount = upstream?.accounts.find((item) => item.accountRef === account?.accountRef) || null;
  const usesNativeSettings = account?.provider === 'zcode';
  const retired = isRetiredEgressBinding(binding);

  // 各来源的行为说明（按 provider 分叉：原生设置只认 HTTP(S) 代理）。
  const sourceHints: Record<AccountEgressMode, ReactNode> = {
    pool: (
      <>
        用你的代理池（订阅聚合的节点）作为出口：AIH 在本机开一个只监听回环的出站端口。
        某个节点被上游限流或连不上时自动冷却并换下一个节点，冷却结束或探测通过后恢复使用。
        绑定只记「用池」，池换端口或换节点都不用重新绑定。每个节点的使用情况在「开发工具 → 网络 → 出口池」查看。
      </>
    ),
    url: usesNativeSettings ? (
      <>支持 http(s)://host:port 或 host:port。该客户端的原生代理字段只认 HTTP(S)，SOCKS5 请在本机代理客户端另开一个 HTTP 端口。</>
    ) : (
      <>支持 http(s)://host:port、socks5://host:port 与 host:port 简写；不支持 socks4 与带账号密码的地址。个别客户端只认 HTTP(S)（例如基于 Bun 的 opencode），填 SOCKS5 时保存会明确提示。</>
    ),
    system: usesNativeSettings ? (
      <>按 HTTPS、HTTP 顺序读取当前系统代理；该客户端的原生代理字段只认 HTTP(S)。未配置可用项时拒绝启动，不会修改系统设置。</>
    ) : (
      <>按 HTTPS、HTTP、SOCKS5 顺序读取当前系统代理（只认 HTTP(S) 的客户端，例如 opencode，跳过 SOCKS5）；都没有可用的时拒绝启动，不会修改系统设置。</>
    ),
    tun: (
      <>仅在检测到外部 TUN 已激活时使用：账号直连，由 TUN 接管；AIH 不创建、不启停，也不接管该 TUN。</>
    ),
    direct: (
      <>
        该账号不走任何代理：网关请求明确绕开服务端配置的全局上游代理，CLI 不注入代理变量，桌面端以 --no-proxy-server 启动
        （该客户端原生设置里由 AIH 写入的托管代理会被清除）。与「未绑定出口」的区别是它会覆盖全局代理；
        本机已开启的系统代理或 TUN 属于系统级网络，AIH 不改写它们。
      </>
    )
  };

  const showBinding = (response: AccountEgressResponse) => {
    setBinding(response.binding || null);
    if (Object.prototype.hasOwnProperty.call(response, 'runtime')) setRuntime(response.runtime || null);
    setRuntimeError(response.runtimeError || '');
  };

  // 上游视图读失败不影响出口设置本身（只是少了节点判定与同上游提示）。
  const loadUpstream = async (accountRef: string, isCancelled: () => boolean = () => false) => {
    try {
      const next = await egressUpstreamAPI.view(accountRef);
      if (!isCancelled()) setUpstreamView(next);
    } catch {
      /* 可选信息 */
    }
  };

  const probeNodes = async (nodes: string[]) => {
    if (!upstream || nodes.length === 0) return;
    setProbing(true);
    try {
      const result = await egressUpstreamAPI.probe(upstream.id, nodes);
      if (!result.ok) message.warning(describeEgressError(result.error));
      else if (result.background) message.info(`已在后台测试 ${result.count} 个节点`);
      else {
        const blocked = (result.results || []).filter((item) => item.status === 'blocked').length;
        message.success(`测试完成：${(result.results || []).length - blocked} 个可连通，${blocked} 个被拒`);
      }
      if (account) await loadUpstream(account.accountRef);
    } finally {
      setProbing(false);
    }
  };

  /** 保存成功后：同上游还有没设置出口的账号，提示一起设置同样的出口（每个账号仍是独立绑定）。 */
  const offerSameUpstream = (input: AccountEgressBindingInput) => {
    if (!account) return;
    const others = sameUpstreamUnbound(upstream, account.accountRef);
    if (others.length === 0) return;
    Modal.confirm({
      title: `${upstream?.host} 还有 ${others.length} 个账号未设置出口`,
      content: (
        <div className="egress-same-upstream">
          <p>它们与当前账号访问同一个上游，地区限制相同。要用同样的出口设置吗？之后每个账号仍可单独修改。</p>
          <p className="egress-same-upstream-list">{others.map((item) => item.label || item.accountRef).join('、')}</p>
        </div>
      ),
      okText: `一起设置 ${others.length} 个`,
      cancelText: '暂不',
      onOk: async () => {
        const result = await applyEgressToAccounts(
          others.map((item) => ({ provider: item.provider, accountRef: item.accountRef, label: item.label })),
          input
        );
        if (result.failed.length === 0) message.success(`已为另外 ${result.applied} 个账号设置出口`);
        else message.warning(`${result.applied} 个成功，${result.failed.length} 个失败（${result.failed.map((item) => item.label || item.accountRef).join('、')}）`);
        await loadUpstream(account.accountRef);
      }
    });
  };

  useEffect(() => {
    if (!account) return undefined;
    let cancelled = false;
    setLoading(true);
    setBinding(null);
    setApplyResult(null);
    setRuntime(null);
    setRuntimeError('');
    setAccountRuntimeView(null);
    form.setFieldsValue({ mode: 'url', proxyUrl: '' });

    setUpstreamView(null);
    setPoolSelection(DEFAULT_POOL_SELECTION);
    void loadUpstream(account.accountRef, () => cancelled);
    accountsAPI.getAccountEgress(account.provider, account.accountRef)
      .then((response) => {
        if (cancelled) return;
        showBinding(response);
        void accountsAPI.getAccountEgressRuntime(account.provider, account.accountRef)
          .then((result) => { if (!cancelled) setAccountRuntimeView(result.runtime || null); })
          .catch(() => { if (!cancelled) setAccountRuntimeView(null); });
        const current = response.binding;
        if (current && !current.retired) {
          form.setFieldsValue({ mode: current.mode as AccountEgressMode, proxyUrl: current.proxyUrl || '' });
          if (current.mode === 'pool') {
            setPoolSelection({
              scope: current.scope || DEFAULT_POOL_SELECTION.scope,
              strategy: current.strategy || 'shared'
            });
          }
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
      const input: AccountEgressBindingInput = {
        mode: values.mode,
        proxyUrl: values.mode === 'url' ? String(values.proxyUrl || '').trim() : '',
        ...(values.mode === 'pool' ? { scope: poolSelection.scope, strategy: poolSelection.strategy } : {})
      };
      const response = await accountsAPI.saveAccountEgress(account.provider, account.accountRef, input);
      showBinding(response);
      reportApplyResult(response.apply);
      await loadUpstream(account.accountRef);
      if (!response.apply || response.apply.ok) offerSameUpstream(input);
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
      width={mode === 'pool' ? 780 : 640}
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
        {binding?.mode === 'pool' || mode === 'pool' ? <AccountEgressRuntimePanel runtime={accountRuntimeView} loading={loading} /> : null}
        <div className="egress-runtime hud-panel hud-panel--sm">
          <span className={`egress-runtime-state egress-runtime-state--${runtimeDescription.state}`}>
            <span className={`hud-led${RUNTIME_LED_CLASS[runtimeDescription.state]}`} aria-hidden="true" />
            {runtimeDescription.text}
          </span>
          {resolvedEndpoint ? (
            <Typography.Text code className="egress-runtime-endpoint">{resolvedEndpoint}</Typography.Text>
          ) : null}
          {runtime?.desktopRunning ? <Tag>桌面端运行中{runtime.desktopPid ? ` · PID ${runtime.desktopPid}` : ''}</Tag> : null}
          {mode === 'pool' || binding?.mode === 'pool' ? (
            <Button
              type="link"
              size="small"
              icon={<ApiOutlined />}
              className="egress-pool-link"
              onClick={() => {
                onClose();
                history.push('/toolkit?panel=egress-pool');
              }}
            >
              查看出口池节点
            </Button>
          ) : null}
        </div>
        {upstreamAccount?.network?.status === 'denied' ? (
          <InlineNote tone="error" description={upstreamAccount.network.detail}>
            当前网络（{upstreamAccount.network.geoText || '本机出口'}）被 {upstream?.host} 拒绝：该账号已被禁止使用，请设置出口
          </InlineNote>
        ) : null}
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
          <Form.Item
            name="mode"
            label={(
              <span className="egress-source-label">
                出口来源
                <EgressHint title="出口设置说明">
                  <p>当前仅支持 macOS。AIH 不会改写系统代理，也不创建、不接管 TUN；只有选择「AIH 出口池」时才会运行代理内核，并在本机开一个只监听回环的出站端口，其它来源都不开本地端口。</p>
                  <p>
                    保存时只访问中性连通性地址探测一次，不调用任何 provider 接口。出口不可用时阻止启动与请求并保留现有设置，
                    不会回退到全局代理或直连；绑定记录无法读取或 marker 无法识别时同样阻止启动，用户手工设置不变。
                  </p>
                  <p>
                    {usesNativeSettings
                      ? '该客户端统一读取账号隔离的 setting.json（原生代理字段只支持 HTTP(S) 地址）；用户手工设置会安全合并。'
                      : '在 CLI、桌面端与网关请求边界都直接使用该代理；外部 TUN 与直连模式下不注入代理。'}
                    {' 桌面端正在运行时，保存后会以新出口重启该实例。'}
                  </p>
                </EgressHint>
              </span>
            )}
          >
            <Radio.Group className="aih-choice-tiles">
              <Space direction="vertical">
                {([
                  ['pool', 'AIH 出口池（自动轮换代理池节点）'],
                  ['url', '外部代理地址（HTTP(S) 或 SOCKS5）'],
                  ['system', '现有系统代理（只读复用）'],
                  ['tun', '现有外部 TUN（只读复用）'],
                  ['direct', '直连（绕过任何代理）']
                ] as const).map(([value, label]) => (
                  <Radio key={value} value={value} className="egress-choice-tile">
                    <span className="aih-choice-tile-title">{label}</span>
                    <EgressHint title={label}>{sourceHints[value]}</EgressHint>
                  </Radio>
                ))}
              </Space>
            </Radio.Group>
          </Form.Item>
          {/* 出口来源切换会换掉整块表单（池选择器 ↔ 代理地址）：按 mode 重挂一次再淡入。 */}
          <div key={mode} className="aih-fade-in">
            {mode === 'pool' ? (
              <PoolScopePicker
                upstream={upstream}
                groups={upstreamView?.groups || []}
                poolReady={Boolean(upstreamView?.pool.ready)}
                value={poolSelection}
                onChange={setPoolSelection}
                probing={probing}
                onProbe={(nodes) => void probeNodes(nodes)}
              />
            ) : null}
            {mode === 'url' ? (
              <Form.Item
                name="proxyUrl"
                label="代理地址"
                rules={[{ required: true, whitespace: true, message: '请输入代理地址' }]}
              >
                <Input
                  placeholder={usesNativeSettings ? '127.0.0.1:6152' : 'socks5://127.0.0.1:6153'}
                  autoComplete="off"
                  className="aih-mono-input"
                />
              </Form.Item>
            ) : null}
          </div>
        </Form>
      </Spin>
    </Modal>
  );
}

// 兼容旧引用；页面和新代码统一使用通用命名。
export const ZcodeEgressModal = AccountEgressModal;
