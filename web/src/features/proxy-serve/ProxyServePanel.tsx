import { useCallback, useEffect, useMemo, useState } from 'react';
import { Card, Select, Space, Switch, Tag, Typography, message } from 'antd';
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
  describeProxyServeError,
  proxyServeAPI,
  type ProxyServeService,
  type ProxyServeView
} from './proxy-serve-api';
import './ProxyServePanel.css';

const POLL_INTERVAL_MS = 5000;

const SOURCE_LABELS: Record<string, string> = {
  ssh: 'SSH 主机',
  pool: '出口池'
};

function candidateLabel(candidate: ToolkitProxyCandidate) {
  const source = SOURCE_LABELS[candidate.source] || candidate.source;
  const suffix = candidate.available ? '' : `（不可用${candidate.error ? `：${candidate.error}` : ''}）`;
  return `${candidate.name || candidate.id} · ${source}${suffix}`;
}

function formatStartedAt(value?: number) {
  if (!value) return '';
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/**
 * 本机代理入口面板。
 *
 * 核心持有唯一会话：WebUI 只启停 aih-go 的子进程，租约、健康与续期都在
 * 子进程内完成。系统代理 / TUN 需要操作系统提权，页面只给可复制命令，
 * 不在管理面静默改系统网络或创建 TUN。
 */
export default function ProxyServePanel() {
  const [view, setView] = useState<ProxyServeView | null>(null);
  const [candidates, setCandidates] = useState<ToolkitProxyCandidate[]>([]);
  const [selector, setSelector] = useState('auto');
  const [socks5, setSocks5] = useState(true);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [candidateError, setCandidateError] = useState('');
  const [service, setService] = useState<ProxyServeService | null>(null);
  const [serviceError, setServiceError] = useState('');

  const session = view?.session;
  const running = Boolean(session?.running);

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
    const [viewResult, candidatesResult, serviceResult] = await Promise.allSettled([
      proxyServeAPI.view(),
      toolkitAPI.listProxyCandidates(),
      proxyServeAPI.serviceStatus()
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

  // 选中的候选消失或变为不可用时回到自动选择，避免提交一个已知失败的选择器。
  useEffect(() => {
    if (selector === 'auto' || selector === 'pool') return;
    const candidate = candidates.find((item) => item.id === selector);
    if (!candidate || !candidate.available) setSelector('auto');
  }, [candidates, selector]);

  const options = useMemo(() => {
    const items = [
      { value: 'auto', label: '自动选择 · 首个可用出口' },
      ...candidates.map((candidate) => ({
        value: candidate.id,
        label: candidateLabel(candidate),
        disabled: !candidate.available
      }))
    ];
    return items;
  }, [candidates]);

  const start = async () => {
    setBusy('start');
    setError('');
    try {
      const next = await proxyServeAPI.start({ selector, noSocks: !socks5 });
      setView((current) => ({ ...next, cliAvailable: current?.cliAvailable ?? true }));
      message.success('本机代理入口已开启');
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
      setView((current) => ({ ...next, cliAvailable: current?.cliAvailable ?? true }));
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

  const systemCommand = `sudo aih proxy serve --selector ${selector} --system --system-service "Wi-Fi"`;
  const tunCommand = `sudo aih proxy serve --selector ${selector} --tun`;

  return (
    <section className="toolkit-page toolkit-domain-panel proxy-serve" aria-labelledby="toolkit-proxy-serve">
      <header className="toolkit-panel-header">
        <div>
          <div className="toolkit-panel-kicker">LOCAL PROXY INGRESS</div>
          <h2 id="toolkit-proxy-serve">本机代理入口</h2>
          <Typography.Text type="secondary">
            借用服务端候选出口（SSH 主机 / 出口池 / 节点），在 Server 主机上开一个带租约认证的
            HTTP 与 SOCKS5 入口。入口只监听回环地址，停止时释放租约。
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
        <InlineNote tone="warning">
          {view.cliReason || '未找到与 Server 同目录的 aih-go 可执行文件'}
        </InlineNote>
      ) : null}
      {candidateError ? <InlineNote tone="warning">代理候选读取失败：{candidateError}</InlineNote> : null}

      <Card
        size="small"
        title={<Space><DeploymentUnitOutlined /><strong>入口会话</strong></Space>}
        extra={(
          <Tag
            bordered={false}
            color={running ? 'success' : 'default'}
            icon={running ? <CheckCircleOutlined /> : <DisconnectOutlined />}
          >
            {running ? '运行中' : '未运行'}
          </Tag>
        )}
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          {running ? (
            <>
              <div className="proxy-serve-meta">
                <span>出口：<strong>{session?.name || '解析中'}</strong></span>
                <span>选择器：<code>{session?.selector || 'auto'}</code></span>
                {session?.pid ? <span>PID：{session.pid}</span> : null}
                {session?.startedAt ? <span>启动于 {formatStartedAt(session.startedAt)}</span> : null}
              </div>
              <div className="proxy-serve-urls">
                {session?.httpUrl ? (
                  <div className="proxy-serve-url">
                    <span>HTTP</span>
                    <Typography.Text code copyable={{ text: session.httpUrl }}>{session.httpUrl}</Typography.Text>
                  </div>
                ) : null}
                {session?.socks5Url ? (
                  <div className="proxy-serve-url">
                    <span>SOCKS5</span>
                    <Typography.Text code copyable={{ text: session.socks5Url }}>{session.socks5Url}</Typography.Text>
                  </div>
                ) : null}
              </div>
              <InlineNote tone="info" description="URL 自带租约凭据，只在本管理面展示；泄漏等同于该入口的访问权。">
                入口只监听本机回环地址。
              </InlineNote>
              <Space>
                <Button danger icon={<StopOutlined />} loading={busy === 'stop'} disabled={Boolean(busy)} onClick={() => void stop()}>
                  停止入口
                </Button>
              </Space>
            </>
          ) : (
            <>
              {session?.error ? (
                <InlineNote tone="error">上次入口已退出：{session.error}</InlineNote>
              ) : null}
              <div className="proxy-serve-controls">
                <label className="proxy-serve-field">
                  <span>出口选择器</span>
                  <Select
                    style={{ minWidth: 320, maxWidth: '100%' }}
                    value={selector}
                    options={options}
                    onChange={setSelector}
                    popupMatchSelectWidth={false}
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
                  icon={<PlayCircleOutlined />}
                  loading={busy === 'start'}
                  disabled={Boolean(busy) || (view ? !view.cliAvailable : false)}
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
        title={<Space><CloudServerOutlined /><strong>常驻服务</strong></Space>}
        extra={(
          <Tag
            bordered={false}
            color={service?.installed ? (service.loaded ? 'success' : 'warning') : 'default'}
          >
            {service?.installed ? (service.loaded ? '已加载' : '已安装未加载') : '未安装'}
          </Tag>
        )}
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Typography.Text type="secondary">
            安装为 launchd / systemd --user / Windows 登录任务，登录后自动运行
            <code> aih proxy serve</code>；不会修改系统代理或创建 TUN。
          </Typography.Text>
          {serviceError ? <InlineNote tone="error">常驻服务状态读取或操作失败：{serviceError}</InlineNote> : null}
          {service?.installed ? (
            <div className="proxy-serve-meta">
              <span>选择器：<code>{service.selector || '未记录'}</code></span>
              <span>SOCKS5：{service.noSocks ? '关闭' : '开启'}</span>
              {service.pid ? <span>PID：{service.pid}</span> : null}
              {service.log ? <span>日志：<code>{service.log}</code></span> : null}
            </div>
          ) : null}
          <div className="proxy-serve-controls">
            <label className="proxy-serve-field">
              <span>常驻出口选择器</span>
              <Select
                style={{ minWidth: 320, maxWidth: '100%' }}
                value={selector}
                options={options}
                onChange={setSelector}
                popupMatchSelectWidth={false}
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
              disabled={Boolean(busy) || (view ? !view.cliAvailable : false)}
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
            系统代理与 TUN 会修改操作系统网络，管理面不会自动提权执行。请在 Server 主机的终端里运行
            （macOS 的 --system-service 换成实际的网络服务名；Windows 用管理员 PowerShell，且不需要 sudo）。
          </Typography.Text>
          <div className="proxy-serve-command">
            <span>系统代理</span>
            <Typography.Text code copyable={{ text: systemCommand }}>{systemCommand}</Typography.Text>
          </div>
          <div className="proxy-serve-command">
            <span>TUN 全局接管</span>
            <Typography.Text code copyable={{ text: tunCommand }}>{tunCommand}</Typography.Text>
          </div>
          <Typography.Text type="secondary">
            长期运行可在同一终端执行 <code>aih proxy service install</code>；退出与恢复由该 CLI 自己负责。
          </Typography.Text>
        </Space>
      </Card>
    </section>
  );
}