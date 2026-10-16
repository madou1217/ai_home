import { useCallback, useEffect, useMemo, useState } from 'react';
import { Input, InputNumber, Popconfirm, Segmented, Select, Spin, Tag } from 'antd';
import {
  ApiOutlined,
  CloudServerOutlined,
  FileTextOutlined,
  GatewayOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined
} from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import InlineNote from '@/components/ui/InlineNote';
import CopyableCommand from '../CopyableCommand';
import ToolkitStatusTrack from '../ToolkitStatusTrack';
import { edgeProxyAPI } from './edge-proxy-api';
import {
  EDGE_NGINX_MODES,
  EDGE_PROVIDER_META,
  describeApplyResult,
  describeEdgeError,
  edgeInstallHint
} from './edge-proxy-presentation';
import type { EdgeApplyResult, EdgeNginxMode, EdgePlan, EdgeProvider, EdgeStatus } from './types';

const PROVIDERS: EdgeProvider[] = ['nginx', 'caddy', 'frp'];

function providerTag(status: EdgeStatus | null, provider: EdgeProvider) {
  const info = status?.providers?.[provider];
  if (!info) return <Tag className="toolkit-status-tag">未探测</Tag>;
  if (!info.installed) return <Tag className="toolkit-status-tag" color="default">未安装</Tag>;
  return (
    <Tag className="toolkit-status-tag" color="success">
      已安装{info.version ? ` ${info.version}` : ''}
    </Tag>
  );
}

function providerConfigLine(status: EdgeStatus | null, provider: EdgeProvider) {
  const info = status?.providers?.[provider];
  if (!info) return '未探测';
  const target = info.configDir || info.configPath || '';
  if (!target) return '未探测到配置位置';
  return `${target}${info.writable === false ? '（不可写）' : ''}`;
}

export default function EdgeProxyPanel() {
  const [status, setStatus] = useState<EdgeStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [statusError, setStatusError] = useState('');

  const [provider, setProvider] = useState<EdgeProvider>('nginx');
  const [domain, setDomain] = useState('');
  const [mode, setMode] = useState<EdgeNginxMode>('split');
  const [remotePort, setRemotePort] = useState<number | null>(null);

  const [plan, setPlan] = useState<EdgePlan | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [planError, setPlanError] = useState('');
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<EdgeApplyResult | null>(null);

  const loadStatus = useCallback(async () => {
    setStatusLoading(true);
    setStatusError('');
    try {
      setStatus(await edgeProxyAPI.status());
    } catch (error: unknown) {
      setStatusError(error instanceof Error ? error.message : '读取失败');
    } finally {
      setStatusLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const platform = status?.platform || '';
  const installedCount = useMemo(
    () => PROVIDERS.filter((item) => status?.providers?.[item]?.installed).length,
    [status]
  );

  const planInput = useMemo(() => ({
    provider,
    domain: domain.trim() || undefined,
    mode: provider === 'nginx' ? mode : undefined,
    remotePort: provider === 'frp' && remotePort ? remotePort : undefined
  }), [provider, domain, mode, remotePort]);

  const generatePlan = useCallback(async () => {
    setPlanLoading(true);
    setPlanError('');
    setApplyResult(null);
    try {
      const data = await edgeProxyAPI.plan(planInput);
      if (data.ok === false || !data.plan) {
        setPlan(null);
        setPlanError(describeEdgeError(data.error, platform));
      } else {
        setPlan(data.plan);
      }
    } catch (error: unknown) {
      setPlan(null);
      setPlanError(error instanceof Error ? error.message : '生成失败');
    } finally {
      setPlanLoading(false);
    }
  }, [planInput, platform]);

  const applyPlan = useCallback(async () => {
    setApplying(true);
    try {
      const data = await edgeProxyAPI.apply({ ...planInput, reload: true });
      setApplyResult(data);
      if (data.ok) void loadStatus();
    } catch (error: unknown) {
      setApplyResult({ ok: false, error: 'edge_request_failed', message: error instanceof Error ? error.message : '写入失败' });
    } finally {
      setApplying(false);
    }
  }, [planInput, loadStatus]);

  const applyLine = applyResult ? describeApplyResult(applyResult) : null;

  return (
    <section className="toolkit-page toolkit-domain-panel" aria-labelledby="toolkit-edge-title">
      <header className="toolkit-panel-header">
        <div>
          <div className="toolkit-panel-kicker">ENTRY &amp; FORWARDING</div>
          <h2 id="toolkit-edge-title">入口与转发</h2>
          <p>
            管本机的 nginx / caddy / frp：让中转跟着 443 走、给 WebUI 上 HTTPS、或从 VPS 转进来。
            改动一律先备份再校验，校验不过自动回滚。
          </p>
        </div>
        <div className="toolkit-header-actions">
          <Button icon={<ReloadOutlined />} loading={statusLoading} onClick={() => void loadStatus()}>重新探测</Button>
        </div>
      </header>

      {statusError && <InlineNote tone="error" description={statusError}>本机入口探测失败</InlineNote>}

      {statusLoading && !status ? (
        <div className="toolkit-loading"><Spin size="large" tip="正在探测本机边缘件" /></div>
      ) : status ? (
        <>
          <ToolkitStatusTrack
            ariaLabel="入口转发状态"
            items={[
              {
                label: '转发目标',
                value: `127.0.0.1:${status.aihPort}`,
                detail: '入口软件把流量转给 AIH 自己这个端口，不再另开端口',
                tone: 'info'
              },
              {
                label: '本机边缘件',
                value: `${installedCount} / ${PROVIDERS.length} 已安装`,
                detail: '只按服务端真实探测结果显示，不猜测',
                tone: installedCount ? 'success' : 'warning'
              },
              {
                label: '写入方式',
                value: '备份 → 校验 → 重载',
                detail: '校验失败整体回滚，不留半份配置',
                tone: 'neutral'
              }
            ]}
          />

          <div className="toolkit-observation-grid">
            {PROVIDERS.map((item) => {
              const info = status.providers?.[item];
              return (
                <article className="toolkit-observation-card" key={item}>
                  <span className="toolkit-panel-kicker">{item.toUpperCase()}</span>
                  <h3>{EDGE_PROVIDER_META[item].label} {providerTag(status, item)}</h3>
                  <dl className="toolkit-inspection-list">
                    <div><dt>用途</dt><dd>{EDGE_PROVIDER_META[item].role}</dd></div>
                    <div><dt>能力</dt><dd>{EDGE_PROVIDER_META[item].capability}</dd></div>
                    <div><dt>配置</dt><dd>{providerConfigLine(status, item)}</dd></div>
                    {item === 'frp' && info?.proxies?.length ? (
                      <div>
                        <dt>现有转发</dt>
                        <dd>{info.proxies.map((proxy) => `${proxy.name}(${proxy.type} ${proxy.localPort}→${proxy.remotePort})`).join('、')}</dd>
                      </div>
                    ) : null}
                  </dl>
                  {info && !info.installed ? (
                    <CopyableCommand command={edgeInstallHint(item, platform)} copyLabel="复制安装命令" />
                  ) : null}
                </article>
              );
            })}
          </div>

          <section className="toolkit-proxy-apply" aria-labelledby="toolkit-edge-plan-title">
            <div className="toolkit-detail-heading">
              <div>
                <span>STAGED CHANGE</span>
                <h3 id="toolkit-edge-plan-title">生成计划</h3>
              </div>
              <span className="toolkit-section-note">只生成不落盘：这里看到的内容就是写入时会写的东西</span>
            </div>

            <div className="toolkit-header-actions">
              <Segmented
                value={provider}
                onChange={(value) => {
                  setProvider(value as EdgeProvider);
                  setPlan(null);
                  setApplyResult(null);
                }}
                options={PROVIDERS.map((item) => ({ value: item, label: EDGE_PROVIDER_META[item].label }))}
              />
              {provider !== 'frp' ? (
                <Input
                  style={{ minWidth: 220 }}
                  value={domain}
                  onChange={(event) => setDomain(event.target.value)}
                  placeholder="域名，例如 aih.example.com"
                  aria-label="域名"
                />
              ) : null}
              {provider === 'nginx' ? (
                <Select
                  style={{ minWidth: 200 }}
                  value={mode}
                  onChange={(value) => setMode(value as EdgeNginxMode)}
                  aria-label="转发形态"
                  options={EDGE_NGINX_MODES.map((item) => ({ value: item.value, label: item.label }))}
                />
              ) : null}
              {provider === 'frp' ? (
                <InputNumber
                  style={{ minWidth: 160 }}
                  value={remotePort}
                  onChange={setRemotePort}
                  placeholder="VPS 远端端口"
                  aria-label="远端端口"
                />
              ) : null}
              <Button
                type="primary"
                icon={<FileTextOutlined />}
                loading={planLoading}
                disabled={provider !== 'frp' && !domain.trim()}
                onClick={() => void generatePlan()}
              >
                生成计划
              </Button>
            </div>

            {provider === 'nginx' ? (
              <p className="toolkit-section-note">{EDGE_NGINX_MODES.find((item) => item.value === mode)?.detail}</p>
            ) : null}
            {provider === 'frp' ? (
              <p className="toolkit-section-note">只在本机 frpc 配置里补两条 [[proxies]]（TCP + UDP，名字带 aih-server），你自己写的转发不动。</p>
            ) : null}

            {planError && <InlineNote tone="error">{planError}</InlineNote>}
          </section>

          {plan ? (
            <section aria-labelledby="toolkit-edge-preview-title">
              <div className="toolkit-detail-heading">
                <div>
                  <span>DRY RUN</span>
                  <h3 id="toolkit-edge-preview-title">{plan.files.length} 个文件将被写入</h3>
                </div>
              </div>
              <InlineNote tone="info" icon={<GatewayOutlined />} description={plan.notes?.join('；')}>{plan.summary}</InlineNote>
              {plan.files.map((file) => (
                <div key={file.path}>
                  <div className="toolkit-detail-heading">
                    <div>
                      <span>{file.topLevel ? 'TOP-LEVEL INCLUDE' : file.append ? 'MANAGED BLOCK' : 'SITE'}</span>
                      <h3>{file.path}</h3>
                    </div>
                  </div>
                  <CopyableCommand command={file.content} copyLabel="复制配置" />
                </div>
              ))}
              <div className="toolkit-header-actions">
                <Popconfirm
                  title="写入并重载？"
                  description="先备份原配置；校验不通过会整体回滚。"
                  okText="写入"
                  cancelText="取消"
                  onConfirm={() => void applyPlan()}
                >
                  <Button type="primary" icon={<SafetyCertificateOutlined />} loading={applying}>写入并重载</Button>
                </Popconfirm>
              </div>
            </section>
          ) : null}

          {applyLine ? (
            <InlineNote tone={applyLine.tone} icon={<CloudServerOutlined />} description={applyLine.detail || undefined}>
              {applyLine.text}
            </InlineNote>
          ) : null}

          <p className="toolkit-section-note">
            <ApiOutlined /> 命令行等价入口：<code>aih edge status | plan | apply</code>（Linux 上配置目录属 root，需要 sudo 执行）。
          </p>
        </>
      ) : null}
    </section>
  );
}
