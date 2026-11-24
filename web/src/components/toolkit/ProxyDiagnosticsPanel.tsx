import { useMemo } from 'react';
import { Input, Segmented, Select, Space, Tag, Tooltip } from 'antd';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  DeleteOutlined,
  LinkOutlined,
  ReloadOutlined,
  SaveOutlined,
  ThunderboltOutlined
} from '@ant-design/icons';
import HudStateView from '@/components/hud/HudStateView';
import Button from '@/components/ui/AppButton';
import InlineNote from '@/components/ui/InlineNote';
import Reveal from '@/components/ui/Reveal';
import { SettingRow, SettingSection } from '@/components/ui/SettingSection';
import SettingStatusTag from '@/components/ui/SettingStatusTag';
import { useSurfaceSwitch } from '@/hooks/use-surface-switch';
import ToolkitEmptyState from './ToolkitEmptyState';
import ToolkitPanelHeader from './ToolkitPanelHeader';
import ToolkitStatusTrack from './ToolkitStatusTrack';
import { effectiveRouteLabel, useProxyDiagnostics, type ProbeRoute } from './use-proxy-diagnostics';
import './ToolkitPanels.css';

function proxyValue(value: string | undefined) {
  return value
    ? <code>{value}</code>
    : <span className="toolkit-observation-empty">未设定</span>;
}

export default function ProxyDiagnosticsPanel() {
  const {
    proxyData,
    proxyLoading,
    proxyError,
    gatewayProxyUrl,
    connectivityData,
    connectivityLoading,
    connectivityError,
    toolTargets,
    proxyInputs,
    setProxyInput,
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
  const { surfaceRef: probeSurfaceRef, switchSurface: switchProbeSurface } = useSurfaceSwitch<HTMLDivElement>();

  const persistedToolValues = useMemo(() => {
    const map: Record<string, string> = {};
    if (!proxyData) return map;
    for (const target of toolTargets) {
      const info = proxyData.tools[target.id];
      map[target.id] = (info?.httpProxy || info?.httpsProxy || '').trim();
    }
    return map;
  }, [proxyData, toolTargets]);

  const selectedSourceMeta = useMemo(
    () => detectedSources.find((source) => source.value === selectedSource),
    [detectedSources, selectedSource]
  );

  const probeStatusTag = connectivityLoading
    ? <SettingStatusTag status="saving" label="连接中" compact />
    : connectivityError
      ? <SettingStatusTag status="error" label="连接失败" compact />
      : connectivityData
        ? (
          <SettingStatusTag
            status={reachableCount === connectivityData.results.length ? 'saved' : 'dirty'}
            label={`${reachableCount} / ${connectivityData.results.length} 可达`}
            compact
          />
        )
        : <SettingStatusTag status="unset" label="未测试" compact />;

  return (
    <section className="toolkit-page toolkit-domain-panel" aria-labelledby="toolkit-proxy-title">
      <ToolkitPanelHeader
        titleId="toolkit-proxy-title"
        title="网络与代理诊断"
        subtitle="查看系统与进程代理探测结果，写入工具代理并测试外部端点连通性。"
        extra={(
          <>
            <Button icon={<ReloadOutlined />} loading={proxyLoading} onClick={fetchProxy}>
              重读配置
            </Button>
            <Button
              type="primary"
              icon={<ThunderboltOutlined />}
              loading={connectivityLoading}
              onClick={() => void testConnectivity(probeRoute)}
            >
              重测端点
            </Button>
          </>
        )}
      />

      {proxyError ? (
        <InlineNote
          tone="error"
          description={proxyError}
          action={<Button size="small" onClick={fetchProxy}>重试</Button>}
        >
          代理状态读取失败
        </InlineNote>
      ) : null}

      {proxyLoading && !proxyData ? (
        <HudStateView variant="loading" code="NETWORK // PROXY" title="正在读取网络代理配置..." compact />
      ) : proxyData ? (
        <div className="toolkit-panel-stack">
          <ToolkitStatusTrack
            ariaLabel="网络代理状态轨道"
            items={[
              { label: '系统代理', value: observation.value, detail: observation.detail, tone: observation.tone },
              {
                label: '可用探测源',
                value: detectedSources.length ? `${detectedSources.length} 个已设定` : '未设定',
                detail: '仅统计接口返回的真实非空地址',
                tone: detectedSources.length ? 'info' : 'warning'
              },
              {
                label: '端点探测',
                value: connectivityLoading
                  ? '连接中'
                  : connectivityData
                    ? `${reachableCount} / ${connectivityData.results.length} 可达`
                    : '未测试',
                detail: effectiveRouteLabel(connectivityData?.networkLayer),
                tone: connectivityError
                  ? 'danger'
                  : connectivityData && reachableCount === connectivityData.results.length
                    ? 'success'
                    : 'neutral'
              }
            ]}
          />

          <SettingSection
            title="代理观测"
            description="对比操作系统代理与 AIH 服务进程环境中的实际配置。"
            status={(
              <SettingStatusTag
                status={proxyData.system?.enabled ? 'saved' : 'unset'}
                label={proxyData.system?.enabled ? '已启用' : '未启用'}
                compact
              />
            )}
          >
            <div className="toolkit-observation-grid" style={{ padding: '12px 0' }}>
              <article className="toolkit-observation-card">
                <div className="toolkit-proxy-tool-head">
                  <h3 className="toolkit-proxy-tool-title">操作系统代理</h3>
                  <SettingStatusTag
                    status={proxyData.system?.enabled ? 'saved' : proxyData.system?.probeStatus === 'error' ? 'error' : 'unset'}
                    label={proxyData.system?.enabled ? '已设定' : proxyData.system?.probeStatus === 'error' ? '失败' : '未设定'}
                    compact
                  />
                </div>
                {proxyData.system ? (
                  <dl className="toolkit-inspection-list">
                    <div><dt>平台 / 状态</dt><dd>{proxyData.system.platform} · {proxyData.system.probeStatus || '未标注'}</dd></div>
                    <div><dt>探测来源</dt><dd>{proxyData.system.source || '未标注'}</dd></div>
                    <div><dt>HTTP</dt><dd>{proxyValue(proxyData.system.httpProxy)}</dd></div>
                    <div><dt>HTTPS</dt><dd>{proxyValue(proxyData.system.httpsProxy)}</dd></div>
                    <div><dt>SOCKS</dt><dd>{proxyValue(proxyData.system.socksProxy)}</dd></div>
                    <div><dt>绕过列表</dt><dd>{proxyData.system.bypassList?.join(', ') || '未设定'}</dd></div>
                  </dl>
                ) : (
                  <InlineNote tone="warning">当前接口未返回系统代理探测能力</InlineNote>
                )}
              </article>

              <article className="toolkit-observation-card">
                <div className="toolkit-proxy-tool-head">
                  <h3 className="toolkit-proxy-tool-title">AIH 进程代理</h3>
                  <SettingStatusTag
                    status={proxyData.gateway?.proxyUrl || proxyData.env.httpProxy || proxyData.env.httpsProxy || proxyData.env.allProxy ? 'saved' : 'unset'}
                    label={proxyData.gateway?.proxyUrl || proxyData.env.httpProxy || proxyData.env.httpsProxy || proxyData.env.allProxy ? '已设定' : '未设定'}
                    compact
                  />
                </div>
                <dl className="toolkit-inspection-list">
                  <div><dt>网关上游</dt><dd>{proxyValue(proxyData.gateway?.proxyUrl || '')}</dd></div>
                  <div><dt>网关绕过</dt><dd>{proxyValue(proxyData.gateway?.noProxy || '')}</dd></div>
                  <div><dt>HTTP_PROXY</dt><dd>{proxyValue(proxyData.env.httpProxy)}</dd></div>
                  <div><dt>HTTPS_PROXY</dt><dd>{proxyValue(proxyData.env.httpsProxy)}</dd></div>
                  <div><dt>ALL_PROXY</dt><dd>{proxyValue(proxyData.env.allProxy)}</dd></div>
                  <div><dt>NO_PROXY</dt><dd>{proxyValue(proxyData.env.noProxy)}</dd></div>
                  <div><dt>作用域</dt><dd>{proxyData.env.scope || 'aih-server-process'}</dd></div>
                </dl>
              </article>
            </div>
          </SettingSection>

          <SettingSection
            title="工具代理配置"
            description="可选用上方真实探测源一键写入，或为单个工具手动保存与清除。"
            status={(
              <SettingStatusTag
                status={detectedSources.length ? 'saved' : 'unset'}
                label={detectedSources.length ? `${detectedSources.length} 个来源可用` : '无探测来源'}
                compact
              />
            )}
          >
            <SettingRow
              title="应用真实探测值"
              description="仅使用系统或进程返回的非空代理地址，不猜测默认端口。"
              layout="stacked"
              control={(
                <Space direction="vertical" size={10} style={{ width: '100%' }}>
                  <Tooltip title={detectedSources.length ? '来源来自上方系统或进程探测' : '暂无可应用的真实探测来源'}>
                    <Select
                      className="toolkit-proxy-select"
                      value={selectedSource || undefined}
                      disabled={!detectedSources.length}
                      placeholder="暂无真实探测来源"
                      onChange={setSelectedSource}
                      options={detectedSources.map((source) => ({
                        value: source.value,
                        label: `${source.label} · ${source.value}`
                      }))}
                      aria-label="选择真实代理来源"
                    />
                  </Tooltip>
                  <Reveal open={Boolean(selectedSource)}>
                    <div className="toolkit-source-note">
                      <strong>当前来源</strong>
                      <code>{selectedSource}</code>
                      <span>{selectedSourceMeta?.origin}</span>
                    </div>
                  </Reveal>
                  <Space wrap size={8}>
                    {toolTargets.map((target) => {
                      const alreadySame = Boolean(selectedSource) && persistedToolValues[target.id] === selectedSource.trim();
                      return (
                        <Button
                          key={target.id}
                          size="small"
                          icon={<LinkOutlined />}
                          disabled={!selectedSource || alreadySame}
                          loading={savingTarget === target.id}
                          onClick={() => saveProxy(target.id, selectedSource, '已应用真实探测值')}
                        >
                          {alreadySame ? `${target.name} 已同步` : `应用到 ${target.name}`}
                        </Button>
                      );
                    })}
                  </Space>
                </Space>
              )}
            />

            <SettingRow
              title="单工具代理地址"
              description="变更后点击保存；未改动或未设定时自动禁用无效操作。"
              layout="stacked"
              control={(
                <div className="toolkit-tool-config-grid">
                  {toolTargets.map((target) => {
                    const draft = proxyInputs[target.id] || '';
                    const trimmedDraft = draft.trim();
                    const persisted = persistedToolValues[target.id] || '';
                    const isDirty = trimmedDraft !== persisted;
                    const isSaving = savingTarget === target.id;
                    const rowStatus = isSaving
                      ? <SettingStatusTag status="saving" label="保存中" compact />
                      : isDirty
                        ? <SettingStatusTag status="dirty" label="未保存" compact />
                        : persisted
                          ? <SettingStatusTag status="saved" label="已设定" compact />
                          : <SettingStatusTag status="unset" label="未设定" compact />;

                    return (
                      <article className="toolkit-tool-config-card" key={target.id}>
                        <div className="toolkit-proxy-tool-head">
                          <div>
                            <h3 className="toolkit-proxy-tool-title">{target.name} 代理</h3>
                            <span className="toolkit-proxy-tool-scope">{target.scopeLabel}</span>
                          </div>
                          {rowStatus}
                        </div>
                        <span className="toolkit-proxy-tool-persisted">
                          当前生效：{persisted || '未设定'}
                        </span>
                        <Input
                          value={draft}
                          placeholder="例如 http://proxy.example:8080"
                          onChange={(event) => setProxyInput(target.id, event.target.value)}
                          aria-label={`${target.name} 代理地址`}
                        />
                        <div className="toolkit-card-button-row">
                          <Button
                            type="primary"
                            size="small"
                            icon={<SaveOutlined />}
                            disabled={!trimmedDraft || !isDirty || Boolean(savingTarget)}
                            loading={isSaving}
                            onClick={() => saveProxy(target.id, trimmedDraft, '代理已保存')}
                          >
                            {isDirty ? '保存' : '已保存'}
                          </Button>
                          {isDirty ? (
                            <Button
                              size="small"
                              disabled={Boolean(savingTarget)}
                              onClick={() => setProxyInput(target.id, persisted)}
                            >
                              恢复
                            </Button>
                          ) : null}
                          <Button
                            size="small"
                            danger
                            icon={<DeleteOutlined />}
                            disabled={!persisted || Boolean(savingTarget)}
                            loading={isSaving}
                            onClick={() => saveProxy(target.id, '', '代理已清除')}
                          >
                            清除
                          </Button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
            />

            {proxyData.tools.git?.scopedProxies && proxyData.tools.git.scopedProxies.length > 0 ? (
              <SettingRow
                title="Git 特定作用域配置"
                description="仅展示本机 Git 配置中带域名前缀的代理规则。"
                layout="stacked"
                control={(
                  <div className="toolkit-scoped-proxies">
                    {proxyData.tools.git.scopedProxies.map((proxy) => (
                      <div key={`${proxy.key}-${proxy.value}`}>
                        <code>{proxy.key}</code>
                        <strong>{proxy.value}</strong>
                      </div>
                    ))}
                  </div>
                )}
              />
            ) : null}
          </SettingSection>
        </div>
      ) : null}

      <SettingSection
        title="外部端点响应测试"
        description={`当前路由：${connectivityData?.route || probeRoute}${connectivityData?.proxyUsed ? ` · 显式代理 ${connectivityData.proxyUsed}` : ` · ${effectiveRouteLabel(connectivityData?.networkLayer)}`}。仅验证 HTTP 响应可达性。`}
        status={probeStatusTag}
        extra={(
          <Segmented
            aria-label="探测路由"
            value={probeRoute}
            onChange={(value) => {
              const nextRoute = value as ProbeRoute;
              switchProbeSurface(() => setProbeRoute(nextRoute), {
                current: probeRoute,
                next: nextRoute,
                direction: nextRoute === 'proxy' ? 'forward' : 'backward'
              });
            }}
            options={[
              { label: '直连', value: 'direct' },
              { label: '网关上游代理', value: 'proxy', disabled: !gatewayProxyUrl }
            ]}
          />
        )}
      >
        <div style={{ padding: '12px 0' }} className="toolkit-panel-stack">
          {connectivityData?.route === 'direct' && connectivityData.networkLayer?.effectiveRoute === 'tun' ? (
            <InlineNote tone="info">
              直连仅代表未使用 AIH 显式代理，系统 TUN / VPN 仍可能接管实际流量。
            </InlineNote>
          ) : null}

          {connectivityError ? (
            <InlineNote
              tone="error"
              description={connectivityError}
              action={<Button size="small" onClick={() => void testConnectivity(probeRoute)}>重试</Button>}
            >
              连通性测试失败
            </InlineNote>
          ) : null}

          <div ref={probeSurfaceRef}>
            {connectivityLoading && !connectivityData ? (
              <HudStateView variant="loading" code="PROBE // HTTP" title="正在测试外部端点响应..." compact />
            ) : connectivityData?.results.length ? (
              <div className="toolkit-connectivity-grid">
                {connectivityData.results.map((result) => (
                  <article key={result.id} data-reachable={result.reachable || undefined}>
                    <div>
                      <span className="toolkit-connectivity-name">
                        <span className={`hud-led ${result.reachable ? 'hud-led--ok' : 'hud-led--err'}`} aria-hidden="true" />
                        <strong>{result.name}</strong>
                      </span>
                      {result.reachable
                        ? <Tag color="success"><CheckCircleOutlined /> 已连接</Tag>
                        : <Tag color="error"><CloseCircleOutlined /> 连接失败</Tag>}
                    </div>
                    <code>{result.host}</code>
                    <span>
                      {result.reachable
                        ? `HTTP ${result.statusCode || '响应'} · ${result.latencyMs} ms · ${result.route || connectivityData.route}`
                        : (result.error || '未收到响应')}
                    </span>
                  </article>
                ))}
              </div>
            ) : (
              <ToolkitEmptyState
                title="暂无端点测试结果"
                description="点击下方按钮对常用外部端点发起一次 HTTP 可达性测试。"
                action={(
                  <Button
                    type="primary"
                    size="small"
                    icon={<ThunderboltOutlined />}
                    onClick={() => void testConnectivity(probeRoute)}
                  >
                    立即测试
                  </Button>
                )}
              />
            )}
          </div>
        </div>
      </SettingSection>
    </section>
  );
}
