import { useEffect, useState, useCallback } from 'react';
import { message } from 'antd';
import { SyncOutlined, CheckCircleFilled, ExclamationCircleFilled } from '@ant-design/icons';
import api from '@/services/api';
import { providerNames } from '@/components/chat/ProviderIcon';
import { SESSION_SYNC_POLICY, SESSION_SYNC_BOUNDARY, SESSION_SYNC_SCOPE } from '@/components/session-sync-copy';
import './RealtimeSyncCard.css';

type ProviderSyncMode = 'hook' | 'polling' | 'unavailable';

interface ProviderHookStatus {
  provider: string;
  supported?: boolean;
  syncMode?: ProviderSyncMode;
  installed?: boolean;
  disabled?: boolean;
  targetKind?: string;
}

// 会话实时同步状态卡:展示全部 10 个 provider 的真实同步方式,不再悄悄隐藏没有官方 hook 的 provider。
// syncMode 三态(后端 provider-session-hook-config.js 的 getProviderSessionSyncMode 派生):
//   hook = 官方 hook 已接入(事件驱动,可一键启用/修复) / polling = 无官方 hook,靠 500ms 文件轮询兜底
//   / unavailable = 连轮询都读不到会话文件。自动安装策略和数据边界由共享文案统一说明。
export default function RealtimeSyncCard() {
  const [rows, setRows] = useState<ProviderHookStatus[]>([]);
  const [loading, setLoading] = useState(false);
  const [installing, setInstalling] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{ ok: boolean; providers: ProviderHookStatus[] }>('/webui/provider-hooks');
      setRows(Array.isArray(res.data?.providers) ? res.data.providers : []);
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const hookRows = rows.filter((r) => r.syncMode === 'hook');
  const pollingRows = rows.filter((r) => r.syncMode === 'polling');
  const unavailableRows = rows.filter((r) => r.syncMode === 'unavailable');
  const missing = hookRows.filter((r) => !r.installed);

  const handleRepair = useCallback(async () => {
    const targets = (missing.length > 0 ? missing : hookRows).map((r) => r.provider);
    if (targets.length === 0) return;
    setInstalling(true);
    try {
      await api.post('/webui/provider-hooks/install', {
        providers: targets,
        confirm: 'install-provider-session-hooks'
      });
      message.success('已启用会话实时同步');
      await load();
    } catch (error: any) {
      message.error(error?.response?.data?.error || error?.message || '启用失败');
    } finally {
      setInstalling(false);
    }
  }, [missing, hookRows, load]);

  const allOn = hookRows.length > 0 && missing.length === 0;
  const providerLabel = (provider: string) => providerNames[provider as keyof typeof providerNames] || provider;

  return (
    <div className="rtsync-card">
      <div className="settings-panel-head">
        <div>
          <h2>会话实时同步</h2>
          <p>{SESSION_SYNC_POLICY} 同步范围：{SESSION_SYNC_SCOPE}。{SESSION_SYNC_BOUNDARY}</p>
        </div>
      </div>

      <div className="rtsync-status-row">
        <span className={`rtsync-overall ${allOn ? 'on' : 'partial'}`}>
          {allOn ? <CheckCircleFilled /> : <ExclamationCircleFilled />}
          {loading ? '检测中…' : allOn ? '官方 hook 已全部启用' : `${hookRows.length - missing.length}/${hookRows.length} provider 官方 hook 已启用`}
        </span>
        <button className="rtsync-repair" onClick={handleRepair} disabled={installing || loading || allOn}>
          <SyncOutlined spin={installing} />
          {allOn ? '已启用' : '一键启用'}
        </button>
      </div>

      <div className="rtsync-chips">
        {hookRows.map((r) => (
          <span key={r.provider} className={`rtsync-chip ${r.installed ? 'on' : 'off'}`} title={r.installed ? `官方 Hook 已安装；事件载荷只包含${SESSION_SYNC_SCOPE}。` : '官方 Hook 未安装，点击「一键启用」写入 AIH 标记的 Hook。'}>
            <span className="rtsync-dot" />
            {providerLabel(r.provider)}
          </span>
        ))}
        {pollingRows.map((r) => (
          <span key={r.provider} className="rtsync-chip poll" title="该 Provider 暂无官方 Hook，通过 session 文件轮询兜底同步，可能有延迟。">
            <span className="rtsync-dot" />
            {providerLabel(r.provider)}
            <span className="rtsync-chip-tag">轮询</span>
          </span>
        ))}
        {unavailableRows.map((r) => (
          <span key={r.provider} className="rtsync-chip na" title="该 Provider 尚不支持会话读取，暂无法同步到网页。">
            <span className="rtsync-dot" />
            {providerLabel(r.provider)}
            <span className="rtsync-chip-tag">不可用</span>
          </span>
        ))}
      </div>
    </div>
  );
}
