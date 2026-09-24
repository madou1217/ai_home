import { useState } from 'react';
import { CloudDownloadOutlined } from '@ant-design/icons';
import type { ProviderCliUpgradeTone } from '@/components/toolkit/provider-cli-upgrade-presentation';
import { useProviderCliUpgrade } from '@/components/toolkit/use-provider-cli-upgrade';
import MobileBoot from '@/mobile/MobileBoot';
import { DetailSheet, EmptySignal, HudSection, KeyValue, MonoList, SwipeRow, TelemetryGrid, TelemetryTile } from '@/mobile/ui';
import type { HudTone } from '@/mobile/ui';
import { InlineError, PanelToolbar, StatusText } from './toolkit-parts';
import styles from '../MobileToolkit.module.css';

const TONES: Record<ProviderCliUpgradeTone, HudTone> = {
  success: 'ok',
  warning: 'warn',
  error: 'err',
  active: 'info',
  neutral: 'muted'
};

/** CLI 自动升级（只读）：调度模式 + 各 provider CLI 版本结论；刷新只重读服务端状态，不触发检查或安装。 */
export default function CliUpgradePanel() {
  const { data, loading, error, fetchStatus, rows, mode, updatable, attention } = useProviderCliUpgrade();
  const [detailProvider, setDetailProvider] = useState('');
  const detailRow = rows.find((row) => row.provider === detailProvider) || null;
  const detailRecord = data?.providers.find((item) => item.provider === detailProvider) || null;

  if (loading && !data) return <MobileBoot label="READING UPGRADE STATE" />;

  return (
    <>
      <PanelToolbar status="只读状态：新版本只在该 CLI 空闲时生效" refreshLabel="刷新状态" refreshing={loading} onRefresh={fetchStatus} />
      {error ? <InlineError title="升级状态读取失败" detail={error} onRetry={fetchStatus} retrying={loading} /> : null}

      {data ? (
        <>
          <TelemetryGrid>
            <TelemetryTile wide label="模式" value={mode.label} tone={TONES[mode.tone]} led sub={mode.detail} />
            <TelemetryTile
              label="版本"
              value={updatable ? updatable : '全部为最新'}
              unit={updatable ? '个有新版' : undefined}
              tone={updatable ? 'warn' : 'ok'}
              led
              sub={`共 ${rows.length} 个可管理 CLI`}
            />
            <TelemetryTile
              label="需要关注"
              value={attention ? attention : '无'}
              unit={attention ? '个异常' : undefined}
              tone={attention ? 'err' : 'muted'}
              led={attention > 0}
              sub={attention ? '回滚或熔断后需要人工确认' : '没有回滚或熔断记录'}
            />
          </TelemetryGrid>

          <HudSection title="Provider CLI" code="CLI" count={rows.length}>
            {rows.length ? (
              <MonoList ariaLabel="CLI 自动升级状态">
                {rows.map((row) => (
                  <SwipeRow key={row.provider} onTap={() => setDetailProvider(row.provider)} ariaLabel={`${row.provider} 升级详情`}>
                    <span className="mhud-row__icon"><CloudDownloadOutlined /></span>
                    <span className="mhud-row__main">
                      <span className="mhud-row__title">{row.provider}</span>
                      <span className="mhud-row__meta">{row.versionText} · {row.lastCheckText}</span>
                    </span>
                    <span className="mhud-row__side">
                      <StatusText tone={TONES[row.statusTone]}>{row.statusLabel}</StatusText>
                    </span>
                  </SwipeRow>
                ))}
              </MonoList>
            ) : (
              <EmptySignal description="当前没有可自动升级的 provider CLI（只有带 npm 包的 CLI 才能钉版本安装与回滚）。" />
            )}
          </HudSection>
        </>
      ) : null}

      <DetailSheet open={Boolean(detailRow)} onClose={() => setDetailProvider('')} code="CLI UPGRADE" title={detailRow?.provider || 'CLI'}>
        {detailRow ? (
          <div className={styles.sheetStack}>
            <KeyValue
              rows={[
                { key: 'status', label: '状态', value: <StatusText tone={TONES[detailRow.statusTone]}>{detailRow.statusLabel}</StatusText> },
                { key: 'version', label: '版本', value: detailRow.versionText },
                { key: 'reason', label: '最近结论', value: detailRow.reasonText || '—', mono: false, tone: detailRow.reasonText ? undefined : 'muted' },
                { key: 'channel', label: '安装渠道', value: detailRow.channelLabel, mono: false },
                { key: 'check', label: '最近检查', value: detailRow.lastCheckText },
                ...(detailRecord?.knownGoodVersion ? [{ key: 'good', label: '回退锚点', value: detailRecord.knownGoodVersion }] : []),
                ...(detailRecord?.blockedVersions?.length
                  ? [{ key: 'blocked', label: '已拉黑版本', value: detailRecord.blockedVersions.join('、') }]
                  : [])
              ]}
            />
            {detailRecord?.blockedVersions?.length ? <p className={styles.prose}>已拉黑版本为验证失败过的版本，不会再被安装。</p> : null}
          </div>
        ) : null}
      </DetailSheet>
    </>
  );
}
