import { useState } from 'react';
import { Input, Select } from 'antd';
import { DeleteOutlined, LinkOutlined, SaveOutlined, ThunderboltOutlined } from '@ant-design/icons';
import {
  effectiveRouteLabel,
  useProxyDiagnostics,
  type ProbeRoute,
  type ProxyTarget
} from '@/components/toolkit/use-proxy-diagnostics';
import MobileBoot from '@/mobile/MobileBoot';
import {
  DetailSheet,
  EmptySignal,
  HudCard,
  HudChips,
  HudField,
  HudIconButton,
  HudSection,
  KeyValue,
  MonoList,
  SwipeRow,
  TelemetryGrid,
  TelemetryTile
} from '@/mobile/ui';
import type { HudTone } from '@/mobile/ui';
import { ActionButton, InlineError, Note, PanelToolbar, StatusText } from './toolkit-parts';
import styles from '../MobileToolkit.module.css';

const OBSERVATION_TONES: Record<'success' | 'warning' | 'danger' | 'neutral', HudTone> = {
  success: 'ok',
  warning: 'warn',
  danger: 'err',
  neutral: 'muted'
};

const EMPTY_VALUE = '接口已返回，未检测到配置';

function proxyValue(value: string | undefined) {
  return value || EMPTY_VALUE;
}

/** 网络与代理诊断：系统 / 进程代理探测、真实来源应用到 Git / npm、手动代理与外部端点响应测试。 */
export default function DiagnosticsPanel() {
  const {
    proxyData,
    proxyLoading,
    proxyError,
    coreStatus,
    coreError,
    connectivityData,
    connectivityLoading,
    connectivityError,
    gitInput,
    setGitInput,
    npmInput,
    setNpmInput,
    selectedSource,
    setSelectedSource,
    savingTarget,
    probeRoute,
    setProbeRoute,
    fetchProxy,
    testConnectivity,
    detectedSources,
    observation,
    reachableCount,
    saveProxy
  } = useProxyDiagnostics();
  const [observationOpen, setObservationOpen] = useState(false);

  if (proxyLoading && !proxyData && !proxyError) return <MobileBoot label="READING PROXY CONFIG" />;

  const selectedOrigin = detectedSources.find((source) => source.value === selectedSource)?.origin;

  return (
    <>
      <PanelToolbar status="区分系统探测、AIH 进程环境与工具配置" refreshLabel="重读配置" refreshing={proxyLoading} onRefresh={() => void fetchProxy()}>
        <HudIconButton icon={<ThunderboltOutlined />} label="重测端点" loading={connectivityLoading} onClick={() => void testConnectivity(probeRoute)} />
      </PanelToolbar>

      {proxyError ? <InlineError title="代理状态读取失败" detail={proxyError} onRetry={() => void fetchProxy()} retrying={proxyLoading} /> : null}
      {coreError ? <Note tone="warn" title="代理池状态未加入诊断来源">{coreError}</Note> : null}

      {proxyData ? (
        <>
          <TelemetryGrid>
            <TelemetryTile
              wide
              label="系统代理实测"
              value={observation.value}
              tone={OBSERVATION_TONES[observation.tone]}
              led
              sub={observation.detail}
              onClick={() => setObservationOpen(true)}
            />
            <TelemetryTile
              wide
              label="真实来源"
              value={detectedSources.length}
              unit="个可用"
              tone={detectedSources.length ? 'info' : 'warn'}
              sub="只统计接口返回的非空系统或进程代理地址"
            />
          </TelemetryGrid>

          <HudCard code="VERIFIED SOURCE" title="应用真实探测值">
            <HudField label="代理来源" hint={detectedSources.length ? '来源均来自系统或进程探测结果' : '当前没有可应用的真实代理地址；不会猜测 localhost 端口'}>
              <Select
                value={selectedSource || undefined}
                disabled={!detectedSources.length}
                placeholder="没有真实探测来源"
                onChange={setSelectedSource}
                options={detectedSources.map((source) => ({ value: source.value, label: `${source.label} · ${source.value}` }))}
                aria-label="选择真实代理来源"
              />
            </HudField>
            {selectedSource && selectedOrigin ? <span className={styles.hint}>{selectedOrigin}</span> : null}
            <div className={styles.buttonRow}>
              <ActionButton icon={<LinkOutlined />} label="应用到 Git" disabled={!selectedSource} loading={savingTarget === 'git'} onClick={() => void saveProxy('git', selectedSource, '已应用真实探测值')} />
              <ActionButton icon={<LinkOutlined />} label="应用到 npm" disabled={!selectedSource} loading={savingTarget === 'npm'} onClick={() => void saveProxy('npm', selectedSource, '已应用真实探测值')} />
            </div>
          </HudCard>

          <ManualProxyCard
            code="GIT GLOBAL"
            title="Git 代理"
            target="git"
            value={gitInput}
            onChange={setGitInput}
            saving={savingTarget === 'git'}
            onSave={saveProxy}
            hint="手动值是用户明确输入，不会自动回退到本地默认端口。"
          />
          <ManualProxyCard
            code="NPM GLOBAL"
            title="npm 代理"
            target="npm"
            value={npmInput}
            onChange={setNpmInput}
            saving={savingTarget === 'npm'}
            onSave={saveProxy}
            hint="保存后会重新读取接口；只有接口返回成功才显示完成反馈。"
          />

          {proxyData.tools.git.scopedProxies && proxyData.tools.git.scopedProxies.length > 0 ? (
            <HudCard code="GIT SCOPED" title="Git 特定作用域配置">
              <KeyValue rows={proxyData.tools.git.scopedProxies.map((proxy) => ({ key: `${proxy.key}-${proxy.value}`, label: proxy.key, value: proxy.value }))} />
            </HudCard>
          ) : null}
        </>
      ) : null}

      <HudSection
        title="外部端点响应测试"
        code={probeRoute === 'proxy' ? 'MIHOMO PROBE' : 'DIRECT PROBE'}
        extra={connectivityData ? (
          <StatusText tone={reachableCount === connectivityData.results.length ? 'ok' : 'warn'}>
            {`${reachableCount} / ${connectivityData.results.length} 可达`}
          </StatusText>
        ) : null}
      >
        <HudChips
          ariaLabel="探测路由"
          value={probeRoute}
          onChange={(value) => setProbeRoute(value as ProbeRoute)}
          items={[
            { key: 'direct', label: '直连' },
            { key: 'proxy', label: 'AIH 代理池', disabled: !coreStatus?.dataPlaneReady }
          ]}
        />
        <p className={styles.prose}>
          当前路由：{connectivityData?.route || probeRoute}
          {connectivityData?.proxyUsed ? ` · 显式代理 ${connectivityData.proxyUsed}` : ` · ${effectiveRouteLabel(connectivityData?.networkLayer)}`}。结果只表示收到 HTTP 响应，不代表 API 鉴权成功或下载吞吐量。
        </p>
        {connectivityData?.route === 'direct' && connectivityData.networkLayer?.effectiveRoute === 'tun' ? (
          <Note tone="info" title="直连探测仍可能经过 TUN">
            直连仅表示本次请求没有显式使用 AIH HTTP 代理；系统 TUN、VPN 或透明代理仍可能接管实际网络路径。
          </Note>
        ) : null}
        {connectivityError ? <InlineError title="连通性测试失败" detail={connectivityError} onRetry={() => void testConnectivity(probeRoute)} retrying={connectivityLoading} /> : null}
        {connectivityLoading && !connectivityData ? (
          <MobileBoot label="PROBING ENDPOINTS" />
        ) : connectivityData?.results.length ? (
          <MonoList ariaLabel="端点测试结果">
            {connectivityData.results.map((result) => (
              <SwipeRow key={result.id}>
                <span className="mhud-row__main">
                  <span className="mhud-row__title">{result.name}</span>
                  <span className="mhud-row__meta">{result.host}</span>
                  <span className="mhud-row__meta">
                    {result.reachable
                      ? `HTTP ${result.statusCode || '响应'} · ${result.latencyMs} ms · ${result.route || connectivityData.route}`
                      : (result.error || '连接失败')}
                  </span>
                </span>
                <span className="mhud-row__side">
                  {result.reachable ? <StatusText tone="ok">HTTP 可达</StatusText> : <StatusText tone="err">未收到响应</StatusText>}
                </span>
              </SwipeRow>
            ))}
          </MonoList>
        ) : (
          <EmptySignal description="没有端点测试结果" />
        )}
      </HudSection>

      <DetailSheet open={observationOpen && Boolean(proxyData)} onClose={() => setObservationOpen(false)} code="OBSERVATION" title="系统与进程代理">
        {proxyData ? (
          <div className={styles.sheetStack}>
            <HudSection title="操作系统代理" code="SYSTEM">
              {proxyData.system ? (
                <KeyValue
                  rows={[
                    { key: 'platform', label: '平台 / 状态', value: `${proxyData.system.platform} · ${proxyData.system.probeStatus || '未标注'}` },
                    { key: 'source', label: '探测来源', value: proxyData.system.source || '未标注' },
                    { key: 'http', label: 'HTTP', value: proxyValue(proxyData.system.httpProxy), tone: proxyData.system.httpProxy ? undefined : 'muted' },
                    { key: 'https', label: 'HTTPS', value: proxyValue(proxyData.system.httpsProxy), tone: proxyData.system.httpsProxy ? undefined : 'muted' },
                    { key: 'socks', label: 'SOCKS', value: proxyValue(proxyData.system.socksProxy), tone: proxyData.system.socksProxy ? undefined : 'muted' },
                    { key: 'bypass', label: '绕过列表', value: proxyData.system.bypassList?.join(', ') || '未返回' }
                  ]}
                />
              ) : (
                <Note tone="warn">当前接口未返回系统代理探测能力</Note>
              )}
            </HudSection>
            <HudSection title="服务进程环境变量" code="AIH PROCESS">
              <KeyValue
                rows={[
                  { key: 'http', label: 'HTTP_PROXY', value: proxyValue(proxyData.env.httpProxy), tone: proxyData.env.httpProxy ? undefined : 'muted' },
                  { key: 'https', label: 'HTTPS_PROXY', value: proxyValue(proxyData.env.httpsProxy), tone: proxyData.env.httpsProxy ? undefined : 'muted' },
                  { key: 'all', label: 'ALL_PROXY', value: proxyValue(proxyData.env.allProxy), tone: proxyData.env.allProxy ? undefined : 'muted' },
                  { key: 'no', label: 'NO_PROXY', value: proxyValue(proxyData.env.noProxy), tone: proxyData.env.noProxy ? undefined : 'muted' },
                  { key: 'scope', label: '作用域', value: proxyData.env.scope || 'aih-server-process' }
                ]}
              />
            </HudSection>
          </div>
        ) : null}
      </DetailSheet>
    </>
  );
}

function ManualProxyCard({ code, title, target, value, onChange, saving, onSave, hint }: {
  code: string;
  title: string;
  target: ProxyTarget;
  value: string;
  onChange: (value: string) => void;
  saving: boolean;
  onSave: (target: ProxyTarget, value: string, action: string) => Promise<void>;
  hint: string;
}) {
  return (
    <HudCard code={code} title={title}>
      <HudField label="全局代理地址" hint={hint}>
        <Input
          value={value}
          placeholder="例如 http://proxy.example:8080"
          onChange={(event) => onChange(event.target.value)}
          aria-label={`${title}地址`}
          inputMode="url"
        />
      </HudField>
      <div className={styles.buttonRow}>
        <ActionButton icon={<SaveOutlined />} label="保存" tone="primary" disabled={!value.trim()} loading={saving} onClick={() => void onSave(target, value, '代理已保存')} />
        <ActionButton icon={<DeleteOutlined />} label="清除" loading={saving} onClick={() => void onSave(target, '', '代理已清除')} />
      </div>
    </HudCard>
  );
}
