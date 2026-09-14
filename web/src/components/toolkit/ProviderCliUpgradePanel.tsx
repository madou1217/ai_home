import { useCallback, useEffect, useMemo, useState } from 'react';
import { Spin, Tag } from 'antd';
import { CloudDownloadOutlined, ReloadOutlined } from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import { toolkitAPI } from '@/services/api';
import type { ProviderCliUpgradeStatusResponse } from '@/types';
import ManagedResourceCard from './ManagedResourceCard';
import ToolkitStatusTrack from './ToolkitStatusTrack';
import {
  getProviderCliUpgradeRows,
  getUpgradeModeSummary,
  type ProviderCliUpgradeTone
} from './provider-cli-upgrade-presentation';

// 只读面板：这里的「刷新」只是重新拉取服务端已有的状态，不会触发检查，更不会安装任何东西。
// 真要手动跑一轮，那是一次分钟级的后台作业（要 spawn 真二进制 + 走 npm 网络），
// 得走 app-install 那套任务队列，不属于这块状态面。

const TAG_COLORS: Record<ProviderCliUpgradeTone, string> = {
  success: 'success',
  warning: 'warning',
  error: 'error',
  active: 'processing',
  neutral: 'default'
};

const TRACK_TONES: Record<ProviderCliUpgradeTone, 'neutral' | 'info' | 'success' | 'warning' | 'danger'> = {
  success: 'success',
  warning: 'warning',
  error: 'danger',
  active: 'info',
  neutral: 'neutral'
};

export default function ProviderCliUpgradePanel() {
  const [data, setData] = useState<ProviderCliUpgradeStatusResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const fetchStatus = useCallback(async () => {
    setLoading(true);
    try {
      const response = await toolkitAPI.getProviderCliUpgradeStatus();
      setData(response);
      setError('');
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : String(fetchError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  const rows = useMemo(() => getProviderCliUpgradeRows(data), [data]);
  const mode = useMemo(() => getUpgradeModeSummary(data?.scheduler || null, data?.global), [data]);
  const updatable = rows.filter((row) => row.statusLabel === '有新版' || row.statusLabel === '待升级').length;
  const attention = rows.filter((row) => row.attention).length;

  return (
    <section className="toolkit-page toolkit-domain-panel" aria-labelledby="toolkit-provider-cli-upgrade">
      <header className="toolkit-panel-header">
        <div>
          <div className="toolkit-panel-kicker">PROVIDER CLI UPGRADE</div>
          <h2 id="toolkit-provider-cli-upgrade">CLI 自动升级</h2>
          <p>后台按周期检查各 provider CLI 的版本状态；新版本只在该 CLI 空闲时生效，不会打断进行中的会话。</p>
        </div>
        <Button icon={<ReloadOutlined />} loading={loading} onClick={fetchStatus}>刷新状态</Button>
      </header>

      {error ? (
        <div className="toolkit-inline-error" role="alert">
          <strong>升级状态读取失败</strong>
          <span>{error}</span>
        </div>
      ) : null}

      {loading && !data ? (
        <div className="toolkit-loading"><Spin size="large" /></div>
      ) : data ? (
        <>
          <ToolkitStatusTrack
            ariaLabel="CLI 自动升级状态轨道"
            items={[
              { label: '模式', value: mode.label, detail: mode.detail, tone: TRACK_TONES[mode.tone] },
              {
                label: '版本',
                value: updatable ? `${updatable} 个有新版` : '全部为最新',
                detail: `共 ${rows.length} 个可管理 CLI`,
                tone: updatable ? 'warning' : 'success'
              },
              {
                label: '需要关注',
                value: attention ? `${attention} 个异常` : '无',
                detail: attention ? '回滚或熔断后需要人工确认' : '没有回滚或熔断记录',
                tone: attention ? 'danger' : 'neutral'
              }
            ]}
          />
          <div className="toolkit-grid">
            {rows.map((row) => {
              const record = data.providers.find((item) => item.provider === row.provider);
              const blocked = record?.blockedVersions || [];
              return (
                <ManagedResourceCard
                  key={row.provider}
                  resourceId={row.provider}
                  name={row.provider}
                  installed={Boolean(record?.installedVersion)}
                  icon={<CloudDownloadOutlined className="toolkit-card-icon" />}
                  badges={<Tag color={TAG_COLORS[row.statusTone]}>{row.statusLabel}</Tag>}
                  details={[
                    { label: '版本', value: row.versionText },
                    { label: '最近结论', value: row.reasonText || '—', muted: !row.reasonText },
                    { label: '安装渠道', value: row.channelLabel },
                    { label: '最近检查', value: row.lastCheckText },
                    ...(record?.knownGoodVersion
                      ? [{ label: '回退锚点', value: record.knownGoodVersion }]
                      : []),
                    ...(blocked.length
                      ? [{ label: '已拉黑版本', value: blocked.join('、'), tooltip: '验证失败过的版本，不会再被安装' }]
                      : [])
                  ]}
                  actions={null}
                />
              );
            })}
          </div>
          {rows.length === 0 ? (
            <p className="toolkit-section-note">当前没有可自动升级的 provider CLI（只有带 npm 包的 CLI 才能钉版本安装与回滚）。</p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
