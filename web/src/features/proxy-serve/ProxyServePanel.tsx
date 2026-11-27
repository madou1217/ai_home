import { useCallback, useEffect, useMemo, useState } from 'react';
import { Card, Input, InputNumber, Segmented, Select, Space, Switch, Tag, Typography, message } from 'antd';
import {
  CheckCircleOutlined,
  CloudServerOutlined,
  DeploymentUnitOutlined,
  DisconnectOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  StopOutlined
} from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import InlineNote from '@/components/ui/InlineNote';
import { toolkitAPI, type ToolkitProxyCandidate } from '@/services/api';
import {
  appsAPI,
  describeProxyServeError,
  proxyServeAPI,
  type LocalApp,
  type ProxyServeService,
  type ProxyServeSSHConnection,
  type ProxyServeView
} from './proxy-serve-api';
import './ProxyServePanel.css';

const POLL_INTERVAL_MS = 5000;

const SOURCE_LABELS: Record<string, string> = {
  ssh: 'SSH 主机',
  pool: '出口池'
};

type ProxyTransport = 'server' | 'ssh-peer';

function candidateLabel(candidate: ToolkitProxyCandidate) {
  const source = SOURCE_LABELS[candidate.source] || candidate.source;
  const suffix = candidate.available ? '' : `（不可用${candidate.error ? `：${candidate.error}` : ''}）`;
  return `${candidate.name || candidate.id} · ${source}${suffix}`;
}

function formatStartedAt(value?: number) {
  if (!value) return '';
  return new Date(value).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

/**
 * 本机代理入口面板。
 *
 * 核心持有唯一会话：WebUI 只启停 aih-go 的子进程，租约、健康与续期都在
 * 子进程内完成。SSH 对等模式在远端启动远端自己的代理入口，只把入口端口
 * 转发回来；远端 Management Key 不出对端。系统代理 / TUN 需要提权，
 * 页面只给可复制命令，不在管理面静默改系统网络或创建 TUN。
 */
export default function ProxyServePanel() {
  const [view, setView] = useState<ProxyServeView | null>(null);
  const [candidates, setCandidates] = useState<ToolkitProxyCandidate[]>([]);
  const [sshConnections, setSSHConnections] = useState<ProxyServeSSHConnection[]>([]);
  const [transport, setTransport] = useState<ProxyTransport>('server');
  const [peer, setPeer] = useState('');
  const [peerVia, setPeerVia] = useState('');
  const [peerAih, setPeerAih] = useState('');
  const [selector, setSelector] = useState('auto');
  const [socks5, setSocks5] = useState(true);
  const [httpPort, setHttpPort] = useState(6152);
  const [socksPort, setSocksPort] = useState(6153);
  const [anonymous, setAnonymous] = useState(true);
  const [apps, setApps] = useState<LocalApp[]>([]);
  const [appID, setAppID] = useState('');
  const [appBusy, setAppBusy] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [candidateError, setCandidateError] = useState('');
  const [service, setService] = useState<ProxyServeService | null>(null);
  const [serviceError, setServiceError] = useState('');
  const [sshError, setSSHError] = useState('');

  const session = view?.session;
  const running = Boolean(session?.running);
  const peerMode = transport === 'ssh-peer';

  const refreshView = useCallback(async () => {
    try {
      setView(await proxyServeAPI.view());
      setError('');
    } catch (loadError) {
      setError(describeProxyServeError(loadError));
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    const [viewResult, candidatesResult, serviceResult, sshResult, appsResult] = await Promise.allSettled([
      proxyServeAPI.view(),
      toolkitAPI.listProxyCandidates(),
      proxyServeAPI.serviceStatus(),
      proxyServeAPI.listSSHConnections(),
      appsAPI.list()
    ]);
    if (viewResult.status === 'fulfilled') {
      setView(viewResult.value);
      setError('');
    } else {
      setError(describeProxyServeError(viewResult.reason));
    }
    if (candidatesResult.status === 'fulfilled') {
      setCandidates(candidatesResult.value);
      setCandidateError('');
    } else {
      setCandidates([]);
      setCandidateError(describeProxyServeError(candidatesResult.reason));
    }
    if (serviceResult.status === 'fulfilled') {
      setService(serviceResult.value);
      setServiceError('');
    } else {
      setService(null);
      setServiceError(describeProxyServeError(serviceResult.reason));
    }
    if (sshResult.status === 'fulfilled') {
      setSSHConnections(sshResult.value);
      setSSHError('');
    } else {
      setSSHConnections([]);
      setSSHError(describeProxyServeError(sshResult.reason));
    }
    setApps(appsResult.status === 'fulfilled' ? appsResult.value : []);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 子进程可能自行退出（租约续期失败/出口不可用）；页面可见时轻量轮询状态。
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible' && !busy) void refreshView();
    }, POLL_INTERVAL_MS);
    const onVisibility = () => {
      if (document.visibilityState === 'visible' && !busy) void refreshView();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [busy, refreshView]);

  // 本机 Server 模式下，选中的候选消失或不可用时回到自动选择。
  useEffect(() => {
    if (peerMode || selector === 'auto' || selector === 'pool') return;
    const candidate = candidates.find((item) => item.id === selector);
    if (!candidate || !candidate.available) setSelector('auto');
  }, [candidates, peerMode, selector]);

  // 已保存的 SSH 连接被删除时清空对等选择，避免提交已知无效连接。
  useEffect(() => {
    if (!peer) return;
    if (!sshConnections.some((item) => item.id === peer)) setPeer('');
  }, [peer, sshConnections]);

  useEffect(() => {
    if (!peerVia) return;
    if (!sshConnections.some((item) => item.id === peerVia)) setPeerVia('');
  }, [peerVia, sshConnections]);

  const peerLabel = useCallback(
    (connectionID?: string) => {
      if (!connectionID) return '';
      const connection = sshConnections.find((item) => item.id === connectionID);
      return connection?.label || connectionID;
    },
    [sshConnections]
  );

  const candidateOptions = useMemo(
    () => [
      { value: 'auto', label: '自动选择 · 首个可用出口' },
      ...candidates.map((candidate) => ({
        value: candidate.id,
        label: candidateLabel(candidate),
        disabled: !candidate.available
      }))
    ],
    [candidates]
  );

  const peerOptions = useMemo(
    () =>
      sshConnections.map((connection) => ({
        value: connection.id,
        label: `${connection.label} · ${connection.user}@${connection.host}:${connection.port}`
      })),
    [sshConnections]
  );

  const viaOptions = useMemo(
    () =>
      sshConnections
        .filter((connection) => connection.id !== peer)
        .map((connection) => ({
          value: connection.id,
          label: `经 ${connection.label} 跳板`
        })),
    [peer, sshConnections]
  );

  const changeTransport = (value: ProxyTransport) => {
    setTransport(value);
    // 本地候选的节点 ID 不一定存在于远端，切换时回到远端自动选择。
    if (value === 'ssh-peer' && selector !== 'auto' && selector !== 'pool') setSelector('auto');
  };

  const start = async () => {
    if (peerMode && !peer) {
      message.warning('请选择 SSH 对等节点');
      return;
    }
    setBusy('start');
    setError('');
    try {
      const next = await proxyServeAPI.start({
        selector,
        noSocks: !socks5,
        httpPort,
        socksPort,
        anonymous,
        peer: peerMode ? peer : undefined,
        peerVia: peerMode && peerVia ? peerVia : undefined,
        peerAih: peerMode && peerAih.trim() ? peerAih.trim() : undefined
      });
      setView((current) => ({
        ...next,
        cliAvailable: current?.cliAvailable ?? true
      }));
      message.success(peerMode ? '已通过 SSH 借用对等节点入口' : '本机代理入口已开启');
    } catch (startError) {
      const text = describeProxyServeError(startError);
      setError(text);
      message.error(text);
    } finally {
      setBusy('');
    }
  };

  const stop = async () => {
    setBusy('stop');
    try {
      const next = await proxyServeAPI.stop();
      setView((current) => ({
        ...next,
        cliAvailable: current?.cliAvailable ?? true
      }));
      message.success('本机代理入口已停止');
    } catch (stopError) {
      message.error(describeProxyServeError(stopError));
    } finally {
      setBusy('');
    }
  };

  const refreshService = async () => {
    setBusy('service-refresh');
    try {
      setService(await proxyServeAPI.serviceStatus());
      setServiceError('');
    } catch (serviceLoadError) {
      const text = describeProxyServeError(serviceLoadError);
      setServiceError(text);
      message.error(text);
    } finally {
      setBusy('');
    }
  };

  const installService = async () => {
    if (peerMode) {
      message.warning('常驻服务只支持本机 Server 来源');
      return;
    }
    setBusy('service-install');
    setServiceError('');
    try {
      setService(await proxyServeAPI.installService({ selector, noSocks: !socks5 }));
      message.success(service?.installed ? '常驻服务配置已更新' : '常驻服务已安装');
    } catch (serviceInstallError) {
      const text = describeProxyServeError(serviceInstallError);
      setServiceError(text);
      message.error(text);
    } finally {
      setBusy('');
    }
  };

  const uninstallService = async () => {
    setBusy('service-uninstall');
    setServiceError('');
    try {
      setService(await proxyServeAPI.uninstallService());
      message.success('常驻服务已移除');
    } catch (serviceUninstallError) {
      const text = describeProxyServeError(serviceUninstallError);
      setServiceError(text);
      message.error(text);
    } finally {
      setBusy('');
    }
  };

  const launchApp = async (proxy: boolean) => {
    if (!appID) return;
    setAppBusy(proxy ? 'proxy' : 'plain');
    try {
      const result = await appsAPI.launch({ id: appID, proxy });
      message.success(
        proxy
          ? `已启动 ${result.app.name}（独立实例，代理 ${result.proxyUrl}，${result.proxyLabel}）`
          : `已启动 ${result.app.name}`
      );
      if (proxy && result.app.proxyMode === 'environment') {
        message.info('该应用通过环境变量读取代理；若它忽略 HTTP(S)_PROXY，代理不会生效。');
      }
    } catch (launchError) {
      message.error(describeProxyServeError(launchError));
    } finally {
      setAppBusy('');
    }
  };

  const systemCommand = `sudo aih proxy serve --selector ${selector} --system --system-service "Wi-Fi"`;
  const tunCommand = `sudo aih proxy serve --selector ${selector} --tun`;
  const runningPeer = session?.transport === 'ssh-peer';

  return (
    <section className="toolkit-page toolkit-domain-panel proxy-serve" aria-labelledby="toolkit-proxy-serve">
      <header className="toolkit-panel-header">
        <div>
          <div className="toolkit-panel-kicker">LOCAL PROXY INGRESS</div>
          <h2 id="toolkit-proxy-serve">本机代理入口</h2>
          <Typography.Text type="secondary">
            借用出口（SSH 主机 / 出口池 / 节点），在本机开一个带租约认证的 HTTP 与 SOCKS5 入口； 也可以经已保存的 SSH
            连接，在远端 AIH 上启动入口并只把端口转发回来。
          </Typography.Text>
        </div>
        <Space size={6}>
          <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
            刷新
          </Button>
        </Space>
      </header>

      {error ? <InlineNote tone="error">代理入口状态读取或操作失败：{error}</InlineNote> : null}
      {view && !view.cliAvailable ? (
        <InlineNote tone="warning">{view.cliReason || '未找到与 Server 同目录的 aih-go 可执行文件'}</InlineNote>
      ) : null}
      {candidateError && !peerMode ? <InlineNote tone="warning">代理候选读取失败：{candidateError}</InlineNote> : null}
      {sshError && peerMode ? <InlineNote tone="warning">SSH 连接读取失败：{sshError}</InlineNote> : null}

      <Card
        size="small"
        title={
          <Space>
            <DeploymentUnitOutlined />
            <strong>入口会话</strong>
          </Space>
        }
        extra={
          <Tag
            bordered={false}
            color={running ? 'success' : 'default'}
            icon={running ? <CheckCircleOutlined /> : <DisconnectOutlined />}
          >
            {running ? '运行中' : '未运行'}
          </Tag>
        }
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          {running ? (
            <>
              <div className="proxy-serve-meta">
                <span>
                  出口：<strong>{session?.name || '解析中'}</strong>
                </span>
                {runningPeer ? (
                  <span>
                    链路：SSH 对等 → {peerLabel(session?.peer)}
                    {session?.via ? `（经 ${peerLabel(session.via)}）` : ''}
                  </span>
                ) : (
                  <span>链路：本机 Server</span>
                )}
                {runningPeer && session?.path?.mode ? (
                  <Tag
                    bordered={false}
                    color={session.path.mode === 'direct-p2p' ? 'success' : 'default'}
                  >
                    {session.path.mode === 'direct-p2p'
                      ? '直连 P2P · SSH'
                      : session.path.mode === 'peer-relay'
                        ? '对等中继 · SSH'
                        : '路径未知'}
                  </Tag>
                ) : null}
                <span>
                  选择器：<code>{session?.selector || 'auto'}</code>
                </span>
                {session?.pid ? <span>PID：{session.pid}</span> : null}
                {session?.startedAt ? <span>启动于 {formatStartedAt(session.startedAt)}</span> : null}
              </div>
              {runningPeer && session?.path?.source ? (
                <Typography.Text type="secondary">
                  路径证据：{session.path.source} / {session.path.path || 'direct'} / {session.path.transport || 'ssh'}
                  （{session.path.confidence || 'configured'}；按已配置拓扑判定）
                </Typography.Text>
              ) : null}
              <div className="proxy-serve-urls">
                {session?.httpUrl ? (
                  <div className="proxy-serve-url">
                    <span>HTTP</span>
                    <Typography.Text code copyable={{ text: session.httpUrl }}>
                      {session.httpUrl}
                    </Typography.Text>
                  </div>
                ) : null}
                {session?.socks5Url ? (
                  <div className="proxy-serve-url">
                    <span>SOCKS5</span>
                    <Typography.Text code copyable={{ text: session.socks5Url }}>
                      {session.socks5Url}
                    </Typography.Text>
                  </div>
                ) : null}
              </div>
              <InlineNote tone="info" description="URL 自带租约凭据，只在本管理面展示；泄漏等同于该入口的访问权。">
                入口只监听本机回环地址。
              </InlineNote>
              <Space>
                <Button
                  danger
                  icon={<StopOutlined />}
                  loading={busy === 'stop'}
                  disabled={Boolean(busy)}
                  onClick={() => void stop()}
                >
                  停止入口
                </Button>
              </Space>
            </>
          ) : (
            <>
              {session?.error ? <InlineNote tone="error">上次入口已退出：{session.error}</InlineNote> : null}
              <div className="proxy-serve-controls">
                <label className="proxy-serve-field">
                  <span>入口来源</span>
                  <Segmented
                    value={transport}
                    onChange={(value) => changeTransport(value as ProxyTransport)}
                    options={[
                      { label: '本机 Server', value: 'server' },
                      { label: 'SSH 对等节点', value: 'ssh-peer' }
                    ]}
                  />
                </label>
              </div>
              {peerMode ? (
                <div className="proxy-serve-controls">
                  <label className="proxy-serve-field">
                    <span>对等节点</span>
                    <Select
                      style={{ minWidth: 320, maxWidth: '100%' }}
                      value={peer || undefined}
                      placeholder="选择已保存的 SSH 连接"
                      options={peerOptions}
                      onChange={setPeer}
                      popupMatchSelectWidth={false}
                    />
                  </label>
                  <label className="proxy-serve-field">
                    <span>跳板（可选）</span>
                    <Select
                      style={{ minWidth: 220, maxWidth: '100%' }}
                      value={peerVia || undefined}
                      placeholder="直连对等节点"
                      options={viaOptions}
                      onChange={setPeerVia}
                      allowClear
                      popupMatchSelectWidth={false}
                    />
                  </label>
                </div>
              ) : null}
              <div className="proxy-serve-controls">
                <label className="proxy-serve-field">
                  <span>{peerMode ? '远端选择器' : '出口选择器'}</span>
                  {peerMode ? (
                    <Input
                      style={{ width: 320, maxWidth: '100%' }}
                      value={selector}
                      placeholder="auto / pool / 远端节点 ID"
                      onChange={(event) => setSelector(event.target.value)}
                    />
                  ) : (
                    <Select
                      style={{ minWidth: 320, maxWidth: '100%' }}
                      value={selector}
                      options={candidateOptions}
                      onChange={setSelector}
                      popupMatchSelectWidth={false}
                    />
                  )}
                </label>
                <label className="proxy-serve-field proxy-serve-switch">
                  <span>同时提供 SOCKS5</span>
                  <Switch checked={socks5} onChange={setSocks5} />
                </label>
              </div>
              <div className="proxy-serve-controls">
                <label className="proxy-serve-field">
                  <span>HTTP 端口</span>
                  <InputNumber min={0} max={65535} value={httpPort} onChange={(value) => setHttpPort(Number(value) || 0)} />
                </label>
                <label className="proxy-serve-field">
                  <span>SOCKS5 端口</span>
                  <InputNumber min={0} max={65535} value={socksPort} onChange={(value) => setSocksPort(Number(value) || 0)} />
                </label>
                <label className="proxy-serve-field proxy-serve-switch">
                  <span>匿名入口（无需 aih:password）</span>
                  <Switch checked={anonymous} onChange={setAnonymous} />
                </label>
              </div>
              {peerMode ? (
                <div className="proxy-serve-controls">
                  <label className="proxy-serve-field">
                    <span>远端 aih 路径（可选）</span>
                    <Input
                      style={{ width: 420, maxWidth: '100%' }}
                      value={peerAih}
                      placeholder="留空自动探测（Windows 可填 C:\\Users\\...\\aih-go.exe）"
                      onChange={(event) => setPeerAih(event.target.value)}
                    />
                  </label>
                </div>
              ) : null}
              {peerMode ? (
                <InlineNote
                  tone="info"
                  description="无跳板的 SSH 直连报告 direct-p2p；带 --peer-via 或连接记录含 egressConnectionId 报告 peer-relay。Tailscale/WireGuard 只是其他传输实现，不是直连 P2P 的定义。"
                >
                  远端运行它自己的 aih proxy serve，远端 Management Key 不出对端。
                </InlineNote>
              ) : null}
              <Space>
                <Button
                  type="primary"
                  icon={<PlayCircleOutlined />}
                  loading={busy === 'start'}
                  disabled={Boolean(busy) || (view ? !view.cliAvailable : false) || (peerMode && !peer)}
                  onClick={() => void start()}
                >
                  启动入口
                </Button>
              </Space>
            </>
          )}
        </Space>
      </Card>

      <Card
        size="small"
        title={
          <Space>
            <DeploymentUnitOutlined />
            <strong>应用代理启动</strong>
          </Space>
        }
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Typography.Text type="secondary">
            应用清单与 alt+space 工作台同源；代理只注入本次启动的进程。Chromium
            系使用独立 profile 与 --proxy-server，其它应用注入 HTTP(S)_PROXY（应用若不读取则不生效）。
          </Typography.Text>
          <Space wrap>
            <Select
              showSearch
              style={{ minWidth: 320, maxWidth: '100%' }}
              placeholder="选择本机应用（可搜索名称或别名）"
              value={appID || undefined}
              optionFilterProp="label"
              options={apps.map((app) => ({
                value: app.id,
                label: `${app.name}（${app.kind} · 代理: ${app.proxyLabel}）`
              }))}
              onChange={setAppID}
              popupMatchSelectWidth={false}
            />
            <Button disabled={!appID || Boolean(appBusy)} loading={appBusy === 'plain'} onClick={() => void launchApp(false)}>
              普通启动
            </Button>
            <Button
              type="primary"
              disabled={!appID || Boolean(appBusy)}
              loading={appBusy === 'proxy'}
              onClick={() => void launchApp(true)}
            >
              带代理启动
            </Button>
          </Space>
        </Space>
      </Card>

      <Card
        size="small"
        title={
          <Space>
            <CloudServerOutlined />
            <strong>常驻服务</strong>
          </Space>
        }
        extra={
          <Tag bordered={false} color={service?.installed ? (service.loaded ? 'success' : 'warning') : 'default'}>
            {service?.installed ? (service.loaded ? '已加载' : '已安装未加载') : '未安装'}
          </Tag>
        }
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Typography.Text type="secondary">
            安装为 launchd / systemd --user / Windows 登录任务，登录后自动运行
            <code> aih proxy serve</code>；不会修改系统代理或创建 TUN。
          </Typography.Text>
          {peerMode ? (
            <InlineNote tone="info">
              常驻服务只使用本机 Server 来源；SSH 对等入口需要手动启动，不写入登录任务。
            </InlineNote>
          ) : null}
          {serviceError ? <InlineNote tone="error">常驻服务状态读取或操作失败：{serviceError}</InlineNote> : null}
          {service?.installed ? (
            <div className="proxy-serve-meta">
              <span>
                选择器：<code>{service.selector || '未记录'}</code>
              </span>
              <span>SOCKS5：{service.noSocks ? '关闭' : '开启'}</span>
              {service.pid ? <span>PID：{service.pid}</span> : null}
              {service.log ? (
                <span>
                  日志：<code>{service.log}</code>
                </span>
              ) : null}
            </div>
          ) : null}
          <div className="proxy-serve-controls">
            <label className="proxy-serve-field">
              <span>常驻出口选择器</span>
              <Select
                style={{ minWidth: 320, maxWidth: '100%' }}
                value={selector}
                options={candidateOptions}
                onChange={setSelector}
                popupMatchSelectWidth={false}
                disabled={peerMode}
              />
            </label>
            <label className="proxy-serve-field proxy-serve-switch">
              <span>同时提供 SOCKS5</span>
              <Switch checked={socks5} onChange={setSocks5} />
            </label>
          </div>
          <Space>
            <Button
              type="primary"
              icon={<CloudServerOutlined />}
              loading={busy === 'service-install'}
              disabled={Boolean(busy) || peerMode || (view ? !view.cliAvailable : false)}
              onClick={() => void installService()}
            >
              {service?.installed ? '更新常驻配置' : '安装常驻服务'}
            </Button>
            {service?.installed ? (
              <Button
                danger
                icon={<StopOutlined />}
                loading={busy === 'service-uninstall'}
                disabled={Boolean(busy)}
                onClick={() => void uninstallService()}
              >
                移除常驻服务
              </Button>
            ) : null}
            <Button
              icon={<ReloadOutlined />}
              loading={busy === 'service-refresh'}
              disabled={Boolean(busy)}
              onClick={() => void refreshService()}
            >
              刷新状态
            </Button>
          </Space>
          {service?.installed && running ? (
            <InlineNote tone="warning">
              常驻服务与页面上的「入口会话」会争用租约和端口，请只保留其中一种运行方式。
            </InlineNote>
          ) : null}
        </Space>
      </Card>

      <Card size="small" title="需要提权的模式">
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Typography.Text type="secondary">
            系统代理与 TUN 会修改操作系统网络，管理面不会自动提权执行。请在 Server 主机的终端里运行 （macOS 的
            --system-service 换成实际的网络服务名；Windows 用管理员 PowerShell，且不需要 sudo）。
          </Typography.Text>
          <div className="proxy-serve-command">
            <span>系统代理</span>
            <Typography.Text code copyable={{ text: systemCommand }}>
              {systemCommand}
            </Typography.Text>
          </div>
          <div className="proxy-serve-command">
            <span>TUN 全局接管</span>
            <Typography.Text code copyable={{ text: tunCommand }}>
              {tunCommand}
            </Typography.Text>
          </div>
          <Typography.Text type="secondary">
            长期运行可在同一终端执行 <code>aih proxy service install</code>
            ；退出与恢复由该 CLI 自己负责。
          </Typography.Text>
        </Space>
      </Card>
    </section>
  );
}
