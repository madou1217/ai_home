import { useEffect, useMemo, useState } from 'react';
import { Switch, Tooltip, message } from 'antd';
import { DesktopOutlined } from '@ant-design/icons';
import type { SystemTranslationStatus } from '@/types';
import { translationAPI } from '@/services/api';
import styles from './translation.module.css';
import { listControlPlaneProfiles } from '@/services/control-plane-profiles';

export default function SystemTranslationControl() {
  const [status, setStatus] = useState<SystemTranslationStatus | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const serverTargets = useMemo(() => [{ label: '本机 AIH Server', origin: window.location.origin }, ...listControlPlaneProfiles().filter((profile) => profile.endpoint && profile.endpoint !== window.location.origin).map((profile) => ({ label: profile.name || profile.endpoint, origin: profile.endpoint }))], []);
  useEffect(() => {
    let disposed = false;
    const refresh = () => {
      void translationAPI.getSystemStatus().then((next) => {
        if (!disposed) { setStatus(next); setError(''); }
      }).catch(() => { if (!disposed) setError('系统取词服务不可用'); });
    };
    refresh();
    const timer = window.setInterval(refresh, 3000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, []);
  return (
    <div className={styles.systemControl}>
      <Tooltip title="在此服务器所在电脑的应用或网页中选词翻译；首次开启需授权辅助功能">
        <span className={styles.floatingToggleLabel}><DesktopOutlined /> 系统取词</span>
      </Tooltip>
      <Switch
        size="small"
        aria-label="系统取词"
        checked={status?.enabled || false}
        disabled={!status?.supported}
        loading={saving}
        onChange={async (enabled) => {
          setSaving(true);
          try {
            setStatus(await translationAPI.setSystemEnabled(enabled));
            window.dispatchEvent(new Event('aih-system-translation-changed'));
          } catch (_error) { message.error('保存系统取词设置失败'); }
          finally { setSaving(false); }
        }}
      />
      <select
        className={styles.systemTargetSelect}
        aria-label="系统取词服务目标"
        value={status?.serverTarget?.origin || window.location.origin}
        disabled={saving}
        onChange={async (event) => {
          const found = serverTargets.find((item) => item.origin === event.target.value);
          if (!found) return;
          setSaving(true);
          try { setStatus(await translationAPI.setSystemServerTarget({ kind: 'aih-server', ...found })); }
          catch (_error) { message.error('切换翻译服务失败'); }
          finally { setSaving(false); }
        }}
      >
        {serverTargets.map((item) => <option key={item.origin} value={item.origin}>{item.label}</option>)}
      </select>
      <span className={styles.systemStatus} role="status">
        {error || (status?.status === 'running' ? '已就绪' : status?.status === 'disabled' ? '' : status?.detail)}
      </span>
      {status?.status === 'permission-required' ? (
        <button type="button" className={styles.systemAction} onClick={() => {
          void translationAPI.requestSystemPermission().catch(() => message.error('无法打开辅助功能设置'));
        }}>去授权</button>
      ) : null}
    </div>
  );
}
