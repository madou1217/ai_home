import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Empty, Input, message, Segmented, Select, Spin, Tag, Tooltip } from 'antd';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  LinkOutlined,
  ReloadOutlined,
  ThunderboltOutlined
} from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import { proxyPoolAPI, toolkitAPI } from '@/services/api';
import type { ConnectivityResponse, ProxyCoreStatus, ProxyStatusResponse } from '@/types';
import ToolkitStatusTrack from './ToolkitStatusTrack';

type ProxyTarget = 'git' | 'npm';
type ProbeRoute = 'direct' | 'proxy';

interface DetectedProxySource {
  label: string;
  value: string;
  origin: string;
}

function uniqueProxySources(data: ProxyStatusResponse | null, core: ProxyCoreStatus | null) {
  if (!data) return [];
  const candidates: DetectedProxySource[] = [
    { label: 'AIH 代理池 mixed', value: core?.mixedProxyUrl || '', origin: 'Mihomo 数据面就绪状态' },
    { label: '系统 HTTP', value: data.system?.httpProxy || '', origin: '操作系统代理探测' },
    { label: '系统 HTTPS', value: data.system?.httpsProxy || '', origin: '操作系统代理探测' },
    { label: '系统 SOCKS', value: data.system?.socksProxy || '', origin: '操作系统代理探测' },
    { label: '进程 HTTP_PROXY', value: data.env.httpProxy || '', origin: 'AIH 服务进程环境' },
    { label: '进程 HTTPS_PROXY', value: data.env.httpsProxy || '', origin: 'AIH 服务进程环境' },
    { label: '进程 ALL_PROXY', value: data.env.allProxy || '', origin: 'AIH 服务进程环境' }
  ].filter((item) => item.value.trim());

  const seen = new Set<string>();
  return candidates.filter((item) => {
    if (seen.has(item.value)) return false;
    seen.add(item.value);
    return true;
  });
}

function proxyValue(value: string | undefined) {
  return value
    ? <code>{value}</code>
    : <span className="toolkit-observation-empty">接口已返回，未检测到配置</span>;
}

function systemObservation(data: ProxyStatusResponse | null) {
  if (!data?.system) {
    return { value: '当前接口不支持', detail: '未返回系统代理探测对象', tone: 'warning' as const };
  }
  if (data.system.enabled) {
    return {
      value: '检测到已启用代理',
      detail: `${data.system.platform} · ${data.system.httpProxy || data.system.httpsProxy || data.system.socksProxy || '地址信息不完整'}`,
      tone: 'success' as const
    };
  }
  if (data.system.probeStatus === 'error') {
    return { value: '系统探测失败', detail: `${data.system.source || data.system.platform} 返回错误`, tone: 'danger' as const };
  }
  if (data.system.probeStatus === 'unsupported') {
    return { value: '当前平台探测不可用', detail: `${data.system.source || data.system.platform} 不受支持或命令不存在`, tone: 'warning' as const };
  }
  return {
    value: '未检测到启用值',
    detail: `${data.system.platform} 探测结果为空；不等同于所有网络层均为直连`,
    tone: 'neutral' as const
  };
}

function apiError(error: unknown, fallback: string) {
  const candidate = error as { message?: string; response?: { data?: { message?: string; error?: string } } };
  return candidate.response?.data?.message || candidate.response?.data?.error || candidate.message || fallback;
}

export default function ProxyDiagnosticsPanel() {
  const [proxyData, setProxyData] = useState<ProxyStatusResponse | null>(null);
  const [proxyLoading, setProxyLoading] = useState(true);
  const [proxyError, setProxyError] = useState('');
  const [coreStatus, setCoreStatus] = useState<ProxyCoreStatus | null>(null);
  const [coreError, setCoreError] = useState('');
  const [connectivityData, setConnectivityData] = useState<ConnectivityResponse | null>(null);
  const [connectivityLoading, setConnectivityLoading] = useState(true);
  const [connectivityError, setConnectivityError] = useState('');
  const [gitInput, setGitInput] = useState('');
  const [npmInput, setNpmInput] = useState('');
  const [selectedSource, setSelectedSource] = useState('');
  const [savingTarget, setSavingTarget] = useState<ProxyTarget | ''>('');
  const [probeRoute, setProbeRoute] = useState<ProbeRoute>('direct');

  const fetchProxy = useCallback(async () => {
    setProxyLoading(true);
    setProxyError('');
    try {
      setCoreError('');
      const [proxyResult, coreResult] = await Promise.allSettled([
        toolkitAPI.getProxy(),
        proxyPoolAPI.getCoreStatus()
      ]);
      if (coreResult.status === 'fulfilled' && coreResult.value.ok) {
        setCoreStatus(coreResult.value.core);
      } else {
        setCoreStatus(null);
        setCoreError(coreResult.status === 'rejected' ? apiError(coreResult.reason, '代理池状态读取失败') : '代理池状态不可用');
      }
      if (proxyResult.status === 'rejected' || !proxyResult.value.ok) {
        setProxyData(null);
        setGitInput('');
        setNpmInput('');
        throw proxyResult.status === 'rejected' ? proxyResult.reason : new Error('代理状态接口未返回可用结果');
      }
      const response = proxyResult.value;
      setProxyData(response);
      setGitInput(response.tools.git.httpProxy || response.tools.git.httpsProxy || '');
      setNpmInput(response.tools.npm.httpProxy || response.tools.npm.httpsProxy || '');
    } catch (requestError: unknown) {
      setProxyError(apiError(requestError, '读取代理状态失败'));
    } finally {
      setProxyLoading(false);
    }
  }, []);

  const testConnectivity = useCallback(async (route: ProbeRoute) => {
    setConnectivityLoading(true);
    setConnectivityError('');
    setConnectivityData(null);
    try {
      const proxyUrl = route === 'proxy' ? coreStatus?.mixedProxyUrl || '' : undefined;
      if (route === 'proxy' && !proxyUrl) throw new Error('Mihomo 数据面未就绪，不能执行代理路由测试');
      const response = await toolkitAPI.testConnectivity({ route, proxyUrl });
      if (!response.ok) throw new Error('连通性接口未返回可用结果');
      setConnectivityData(response);
    } catch (requestError: unknown) {
      setConnectivityError(apiError(requestError, '端点连通性测试失败'));
    } finally {
      setConnectivityLoading(false);
    }
  }, [coreStatus?.mixedProxyUrl]);

  useEffect(() => {
    void fetchProxy();
  }, [fetchProxy]);

  useEffect(() => {
    void testConnectivity(probeRoute);
  }, [probeRoute, testConnectivity]);

  const detectedSources = useMemo(() => uniqueProxySources(proxyData, coreStatus), [coreStatus, proxyData]);

  useEffect(() => {
    setSelectedSource((current) => detectedSources.some((source) => source.value === current)
      ? current
      : (detectedSources[0]?.value || ''));
  }, [detectedSources]);

  const observation = systemObservation(proxyData);
  const reachableCount = connectivityData?.results.filter((result) => result.reachable).length || 0;

  const saveProxy = async (target: ProxyTarget, value: string, action: string) => {
    setSavingTarget(target);
    try {
      const response = await toolkitAPI.setProxy(target, value.trim());
      if (!response.ok) throw new Error(response.message || response.error || '代理写入接口返回失败');
      await fetchProxy();
      message.success(`${target === 'git' ? 'Git' : 'npm'} ${action}`);
    } catch (requestError: unknown) {
      const detail = apiError(requestError, '写入代理失败');
      message.error(detail);
    } finally {
      setSavingTarget('');
    }
  };

  return (
    <section className="toolkit-page toolkit-domain-panel" aria-labelledby="toolkit-proxy-title">
      <header className="toolkit-panel-header">
        <div>
          <div className="toolkit-panel-kicker">NETWORK OBSERVABILITY</div>
          <h2 id="toolkit-proxy-title">网络与代理诊断</h2>
          <p>明确区分系统探测、AIH 进程环境和工具配置；任何“一键应用”都只使用真实返回值。</p>
        </div>
        <div className="toolkit-header-actions">
          <Button icon={<ReloadOutlined />} loading={proxyLoading} onClick={fetchProxy}>重读配置</Button>
          <Button icon={<ThunderboltOutlined />} loading={connectivityLoading} onClick={() => void testConnectivity(probeRoute)}>重测端点</Button>
        </div>
      </header>

      {proxyError && <Alert type="error" showIcon message="代理状态读取失败" description={proxyError} />}
      {coreError && <Alert type="warning" showIcon message="代理池状态未加入诊断来源" description={coreError} />}
      {proxyLoading && !proxyData ? (
        <div className="toolkit-loading"><Spin size="large" tip="正在读取代理配置" /></div>
      ) : proxyData ? (
        <>
          <ToolkitStatusTrack
            ariaLabel="网络代理状态轨道"
            items={[
              { label: '实测', value: observation.value, detail: observation.detail, tone: observation.tone },
              {
                label: '配置',
                value: `${detectedSources.length} 个真实来源可用`,
                detail: '只统计接口返回的非空系统或进程代理地址',
                tone: detectedSources.length ? 'info' : 'warning'
              },
              {
                label: '指南',
                value: '先选择来源，再应用到工具',
                detail: '无探测来源时不会猜测 localhost 端口',
                tone: 'neutral'
              }
            ]}
          />

          <div className="toolkit-observation-grid">
            <article className="toolkit-observation-card">
              <span className="toolkit-panel-kicker">SYSTEM</span>
              <h3>操作系统代理</h3>
              {proxyData.system ? (
                <dl className="toolkit-inspection-list">
                  <div><dt>平台 / 状态</dt><dd>{proxyData.system.platform} · {proxyData.system.probeStatus || '未标注'}</dd></div>
                  <div><dt>探测来源</dt><dd>{proxyData.system.source || '未标注'}</dd></div>
                  <div><dt>HTTP</dt><dd>{proxyValue(proxyData.system.httpProxy)}</dd></div>
                  <div><dt>HTTPS</dt><dd>{proxyValue(proxyData.system.httpsProxy)}</dd></div>
                  <div><dt>SOCKS</dt><dd>{proxyValue(proxyData.system.socksProxy)}</dd></div>
                  <div><dt>绕过列表</dt><dd>{proxyData.system.bypassList?.join(', ') || '未返回'}</dd></div>
                </dl>
              ) : (
                <Alert type="warning" message="当前接口未返回系统代理探测能力" />
              )}
            </article>

            <article className="toolkit-observation-card">
              <span className="toolkit-panel-kicker">AIH PROCESS</span>
              <h3>服务进程环境变量</h3>
              <dl className="toolkit-inspection-list">
                <div><dt>HTTP_PROXY</dt><dd>{proxyValue(proxyData.env.httpProxy)}</dd></div>
                <div><dt>HTTPS_PROXY</dt><dd>{proxyValue(proxyData.env.httpsProxy)}</dd></div>
                <div><dt>ALL_PROXY</dt><dd>{proxyValue(proxyData.env.allProxy)}</dd></div>
                <div><dt>NO_PROXY</dt><dd>{proxyValue(proxyData.env.noProxy)}</dd></div>
                <div><dt>作用域</dt><dd>{proxyData.env.scope || 'aih-server-process'}</dd></div>
              </dl>
            </article>
          </div>

          <section className="toolkit-proxy-apply" aria-labelledby="toolkit-proxy-apply-title">
            <div className="toolkit-detail-heading">
              <div>
                <span>VERIFIED SOURCE</span>
                <h3 id="toolkit-proxy-apply-title">应用真实探测值</h3>
              </div>
              <Tooltip title={detectedSources.length ? '来源均来自上方系统或进程探测结果' : '当前没有可应用的真实代理地址'}>
                <Select
                  value={selectedSource || undefined}
                  disabled={!detectedSources.length}
                  placeholder="没有真实探测来源"
                  onChange={setSelectedSource}
                  options={detectedSources.map((source) => ({
                    value: source.value,
                    label: `${source.label} · ${source.value}`
                  }))}
                  aria-label="选择真实代理来源"
                />
              </Tooltip>
            </div>
            {selectedSource && (
              <div className="toolkit-source-note">
                <strong>当前选择</strong>
                <code>{selectedSource}</code>
                <span>{detectedSources.find((source) => source.value === selectedSource)?.origin}</span>
              </div>
            )}
            <div className="toolkit-proxy-source-actions">
              <Button
                icon={<LinkOutlined />}
                disabled={!selectedSource}
                loading={savingTarget === 'git'}
                onClick={() => saveProxy('git', selectedSource, '已应用真实探测值')}
              >
                应用到 Git
              </Button>
              <Button
                icon={<LinkOutlined />}
                disabled={!selectedSource}
                loading={savingTarget === 'npm'}
                onClick={() => saveProxy('npm', selectedSource, '已应用真实探测值')}
              >
                应用到 npm
              </Button>
            </div>
          </section>

          <div className="toolkit-tool-config-grid">
            <article className="toolkit-tool-config-card">
              <div>
                <span className="toolkit-panel-kicker">GIT GLOBAL</span>
                <h3>Git 代理</h3>
                <p>手动值是用户明确输入，不会自动回退到本地默认端口。</p>
              </div>
              <Input value={gitInput} placeholder="例如 http://proxy.example:8080" onChange={(event) => setGitInput(event.target.value)} aria-label="Git 全局代理地址" />
              <div className="toolkit-card-button-row">
                <Button type="primary" disabled={!gitInput.trim()} loading={savingTarget === 'git'} onClick={() => saveProxy('git', gitInput, '代理已保存')}>保存</Button>
                <Button loading={savingTarget === 'git'} onClick={() => saveProxy('git', '', '代理已清除')}>清除</Button>
              </div>
            </article>
            <article className="toolkit-tool-config-card">
              <div>
                <span className="toolkit-panel-kicker">NPM GLOBAL</span>
                <h3>npm 代理</h3>
                <p>保存后会重新读取接口；只有接口返回成功才显示完成反馈。</p>
              </div>
              <Input value={npmInput} placeholder="例如 http://proxy.example:8080" onChange={(event) => setNpmInput(event.target.value)} aria-label="npm 全局代理地址" />
              <div className="toolkit-card-button-row">
                <Button type="primary" disabled={!npmInput.trim()} loading={savingTarget === 'npm'} onClick={() => saveProxy('npm', npmInput, '代理已保存')}>保存</Button>
                <Button loading={savingTarget === 'npm'} onClick={() => saveProxy('npm', '', '代理已清除')}>清除</Button>
              </div>
            </article>
          </div>

          {proxyData.tools.git.scopedProxies && proxyData.tools.git.scopedProxies.length > 0 && (
            <section className="toolkit-scoped-proxies" aria-labelledby="toolkit-scoped-proxies-title">
              <h3 id="toolkit-scoped-proxies-title">Git 特定作用域配置</h3>
              {proxyData.tools.git.scopedProxies.map((proxy) => (
                <div key={`${proxy.key}-${proxy.value}`}><code>{proxy.key}</code><strong>{proxy.value}</strong></div>
              ))}
            </section>
          )}
        </>
      ) : null}

      <section className="toolkit-connectivity" aria-labelledby="toolkit-connectivity-title">
        <div className="toolkit-detail-heading">
          <div>
            <span>{probeRoute === 'proxy' ? 'MIHOMO HTTP PROBE' : 'DIRECT HTTP PROBE'}</span>
            <h3 id="toolkit-connectivity-title">外部端点响应测试</h3>
          </div>
          <div className="toolkit-header-actions">
            <Segmented
              value={probeRoute}
              onChange={(value) => setProbeRoute(value as ProbeRoute)}
              options={[
                { label: '直连', value: 'direct' },
                { label: 'AIH 代理池', value: 'proxy', disabled: !coreStatus?.dataPlaneReady }
              ]}
            />
            {connectivityData && <Tag color={reachableCount === connectivityData.results.length ? 'success' : 'warning'}>{reachableCount} / {connectivityData.results.length} 可达</Tag>}
          </div>
        </div>
        <p className="toolkit-section-note">
          当前路由：{connectivityData?.route || probeRoute}
          {connectivityData?.proxyUsed ? ` · ${connectivityData.proxyUsed}` : ' · 未使用代理'}。结果只表示收到 HTTP 响应，不代表 API 鉴权成功或下载吞吐量。
        </p>
        {connectivityError && <Alert type="error" showIcon message="连通性测试失败" description={connectivityError} />}
        {connectivityLoading && !connectivityData ? (
          <div className="toolkit-loading compact"><Spin tip="正在测试端点响应" /></div>
        ) : connectivityData?.results.length ? (
          <div className="toolkit-connectivity-grid">
            {connectivityData.results.map((result) => (
              <article key={result.id} data-reachable={result.reachable || undefined}>
                <div>
                  <strong>{result.name}</strong>
                  {result.reachable
                    ? <Tag color="success"><CheckCircleOutlined /> HTTP 可达</Tag>
                    : <Tag color="error"><CloseCircleOutlined /> 未收到响应</Tag>}
                </div>
                <code>{result.host}</code>
                <span>{result.reachable
                  ? `HTTP ${result.statusCode || '响应'} · ${result.latencyMs} ms · ${result.route || connectivityData.route}`
                  : (result.error || '连接失败')}</span>
              </article>
            ))}
          </div>
        ) : <Empty description="没有端点测试结果" />}
      </section>
    </section>
  );
}
