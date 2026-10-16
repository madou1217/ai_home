import { useCallback, useEffect, useMemo, useState } from 'react';
import { Spin, Tag } from 'antd';
import { ApiOutlined, ReloadOutlined } from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import InlineNote from '@/components/ui/InlineNote';
import CopyableCommand from '../CopyableCommand';
import ToolkitStatusTrack from '../ToolkitStatusTrack';
import EdgePlanCard from './EdgePlanCard';
import { edgeProxyAPI } from './edge-proxy-api';
import { EDGE_PROVIDER_META, edgeInstallHint } from './edge-proxy-presentation';
import type { EdgeProvider, EdgeStatus } from './types';

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

/**
 * 本机入口转发管理（nginx / caddy / frp）：看现状 + 生成计划 + 写入并重载。
 * 挂在「应用与集成」下作为本机软件管理；订阅聚合那边只复用 EdgePlanCard 做 dry-run。
 */
export default function EdgeProxyPanel({ variant = 'page' }: { variant?: 'page' | 'drawer' }) {
  const [status, setStatus] = useState<EdgeStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [statusError, setStatusError] = useState('');

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

  return (
    <section
      className={variant === 'drawer' ? 'toolkit-domain-panel' : 'toolkit-page toolkit-domain-panel'}
      aria-labelledby="toolkit-edge-title"
    >
      {variant === 'page' ? (
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
      ) : null}

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
            <EdgePlanCard
              platform={platform}
              apply={{ onApplied: () => void loadStatus() }}
            />
          </section>

          <p className="toolkit-section-note">
            <ApiOutlined /> 命令行等价入口：<code>aih edge status | plan | apply</code>（Linux 上配置目录属 root，需要 sudo 执行）。
          </p>
        </>
      ) : null}
    </section>
  );
}
