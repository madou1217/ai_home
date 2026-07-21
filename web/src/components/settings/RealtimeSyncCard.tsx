import { useEffect, useState, useCallback } from 'react';
import { message } from 'antd';
import { SyncOutlined, CheckCircleFilled, ExclamationCircleFilled } from '@ant-design/icons';
import api from '@/services/api';
import { providerNames } from '@/components/chat/ProviderIcon';
import './RealtimeSyncCard.css';

interface ProviderHookStatus {
  provider: string;
  supported?: boolean;
  installed?: boolean;
  disabled?: boolean;
  targetKind?: string;
}

// 会话实时同步状态卡：展示各 provider 官方 session-sync hook 是否已安装(已装=CLI 会话事件事件驱动
// 实时推送到 web,而非 500ms 文件轮询)。启动时会自动安装,这里提供可见状态 + 手动「修复」。
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

  const supported = rows.filter((r) => r.supported !== false);
  const missing = supported.filter((r) => !r.installed);

  const handleRepair = useCallback(async () => {
    const targets = (missing.length > 0 ? missing : supported).map((r) => r.provider);
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
  }, [missing, supported, load]);

  const allOn = supported.length > 0 && missing.length === 0;

  return (
    <div className="rtsync-card">
      <div className="settings-panel-head">
        <div>
          <h2>会话实时同步</h2>
          <p>安装各 provider 官方 hook 后,CLI 会话的消息与运行态会事件驱动实时同步到网页(否则退化为轮询)。启动时自动安装。</p>
        </div>
      </div>

      <div className="rtsync-status-row">
        <span className={`rtsync-overall ${allOn ? 'on' : 'partial'}`}>
          {allOn ? <CheckCircleFilled /> : <ExclamationCircleFilled />}
          {loading ? '检测中…' : allOn ? '实时同步已全部启用' : `${supported.length - missing.length}/${supported.length} provider 已启用`}
        </span>
        <button className="rtsync-repair" onClick={handleRepair} disabled={installing || loading || allOn}>
          <SyncOutlined spin={installing} />
          {allOn ? '已启用' : '一键启用'}
        </button>
      </div>

      <div className="rtsync-chips">
        {supported.map((r) => (
          <span key={r.provider} className={`rtsync-chip ${r.installed ? 'on' : 'off'}`}>
            <span className="rtsync-dot" />
            {providerNames[r.provider as keyof typeof providerNames] || r.provider}
          </span>
        ))}
      </div>
    </div>
  );
}
