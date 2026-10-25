import { useEffect, useMemo, useState } from 'react';
import { Switch, Tooltip, message } from 'antd';
import { DesktopOutlined } from '@ant-design/icons';
import type { SystemTranslationStatus, TranslationExecutionTarget } from '@/types';
import { translationAPI } from '@/services/api';
import styles from './translation.module.css';
import {
  addControlPlaneProfilesChangeListener,
  isControlPlaneProfileReady,
  listControlPlaneProfiles,
} from '@/services/control-plane-profiles';
import { getTranslationTargetStatus } from './translation-targets';

interface Props {
  persistedExecutionTarget?: 'aih-server' | 'direct-provider';
}

type SystemServerTargetOption = {
  kind: 'aih-server';
  label: string;
  origin: string;
  serverId?: string;
  available: boolean;
};

function targetKey(target: Pick<SystemServerTargetOption, 'origin' | 'serverId'>) {
  return target.serverId || target.origin;
}

function executionTargetHint(target: TranslationExecutionTarget) {
  const operations = target.capabilities.operations || [];
  const operationLabel: Record<string, string> = {
    selection: '选区',
    batch: '批量',
    page: '页面',
    replace: '替换',
  };
  const operationText = operations.map((operation) => operationLabel[operation] || operation).join('、');
  const providerCount = target.providers?.filter((provider) => provider.configured).length;
  const providerText = providerCount === undefined ? '' : ` · 已配置 ${providerCount}/${target.providers?.length || 0} 个 Provider`;
  return `${target.capabilities.streaming ? '支持流式输出' : '完整结果'}${operationText ? ` · ${operationText}` : ''}${providerText}`;
}

export default function SystemTranslationControl({ persistedExecutionTarget }: Props) {
  const [status, setStatus] = useState<SystemTranslationStatus | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [profileRevision, setProfileRevision] = useState(0);
  const executionTargets = status?.executionTargets || [];
  const selectedExecutionTarget = status?.executionTarget || persistedExecutionTarget || executionTargets.find((target) => target.configured)?.id || executionTargets[0]?.id || '';
  const selectedExecutionTargetDetails = executionTargets.find((target) => target.id === selectedExecutionTarget);
  const serverTargets = useMemo<SystemServerTargetOption[]>(() => {
    // A profile without a management key or a successful health state cannot
    // service native translation through the local proxy. Keep the list honest
    // so switching does not lead to an avoidable authorization error.
    const local: SystemServerTargetOption = {
      kind: 'aih-server',
      label: '本机 AIH Server',
      origin: window.location.origin,
      serverId: '',
      available: true,
    };
    const candidates: SystemServerTargetOption[] = [local, ...listControlPlaneProfiles()
      .filter((profile) => profile.endpoint && profile.endpoint !== window.location.origin && isControlPlaneProfileReady(profile))
      .map((profile) => ({
        kind: 'aih-server' as const,
        label: profile.name || profile.endpoint,
        // The native helper talks to its local server; the profile id selects
        // the remote server through the authenticated server proxy.
        origin: window.location.origin,
        serverId: profile.id,
        available: true,
      }))];
    const current = status?.serverTarget;
    if (current && !candidates.some((item) => targetKey(item) === targetKey(current))) {
      // Preserve a persisted selection so the control reflects reality. It is
      // disabled until the corresponding profile is configured and ready.
      candidates.push({ ...current, available: false });
    }
    const seen = new Set<string>();
    return candidates.filter((item) => {
      const key = targetKey(item);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [profileRevision, status?.serverTarget]);
  useEffect(() => {
    return addControlPlaneProfilesChangeListener(() => setProfileRevision((value) => value + 1));
  }, []);
  useEffect(() => {
    let disposed = false;
    const refresh = () => {
      void translationAPI.getSystemStatus().then((next) => {
        if (!disposed) {
          setStatus(next);
          setError('');
        }
      }).catch(() => { if (!disposed) setError('系统取词服务不可用'); });
    };
    refresh();
    const timer = window.setInterval(refresh, 3000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, []);
  useEffect(() => {
    if (!status) return;
    const targets = serverTargets.map(({ available: _available, ...item }) => item);
    const current = status.serverTarget || targets[0];
    const stored = status.serverTargets || [];
    const signature = (items: typeof targets) => JSON.stringify(items.map((item) => [targetKey(item), item.label, item.origin]));
    if (!current || signature(stored) === signature(targets)) return;
    let disposed = false;
    void translationAPI.setSystemServerTarget(current, targets).then((next) => {
      if (!disposed) setStatus(next);
    }).catch(() => { if (!disposed) setError('服务目标列表同步失败，请稍后重试'); });
    return () => { disposed = true; };
  }, [serverTargets, status]);
  const alternateTargetCount = serverTargets.filter((item) => item.available && item.serverId).length;
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
      {executionTargets.length ? (
        <div className={styles.executionTargetControl}>
          <span className={styles.fieldLabel}>执行目标</span>
          <select
            className={styles.executionTargetSelect}
            aria-label="系统取词执行目标"
            value={selectedExecutionTarget}
            disabled={saving}
            onChange={async (event) => {
              const target = executionTargets.find((item) => item.id === event.target.value);
              if (!target || !target.available || !target.configured) return;
              setSaving(true);
              try {
                setStatus(await translationAPI.setSystemExecutionTarget(target.id as 'aih-server' | 'direct-provider'));
                setError('');
              } catch (_error) {
                setError('切换执行目标失败，请检查目标配置');
              } finally {
                setSaving(false);
              }
            }}
          >
            {executionTargets.map((target) => (
              <option key={target.id} value={target.id} disabled={!getTranslationTargetStatus(target).selectable}>
                {target.label} · {getTranslationTargetStatus(target).label}
              </option>
            ))}
          </select>
          {selectedExecutionTargetDetails ? (
            <span className={styles.executionTargetHint} role="status">
              {executionTargetHint(selectedExecutionTargetDetails)}
            </span>
          ) : null}
        </div>
      ) : null}
      <select
        className={styles.systemTargetSelect}
        aria-label="系统取词服务目标"
        value={status?.serverTarget?.serverId || status?.serverTarget?.origin || window.location.origin}
        disabled={saving}
        onChange={async (event) => {
          const found = serverTargets.find((item) => (item.serverId || item.origin) === event.target.value);
          if (!found) return;
          setSaving(true);
          try { setStatus(await translationAPI.setSystemServerTarget({ ...found }, serverTargets.map((item) => ({ ...item })))); }
          catch (_error) { message.error('切换翻译服务失败'); }
          finally { setSaving(false); }
        }}
      >
        {serverTargets.map((item) => <option key={targetKey(item)} value={targetKey(item)} disabled={!item.available}>{item.label}{item.available ? '' : '（未配置）'}</option>)}
      </select>
      <span className={styles.systemStatus} role="status">
        {error || (!status ? '正在读取服务状态…' : status.status === 'running' ? '已就绪' : status.status === 'disabled' ? '' : status.detail)}
      </span>
      {alternateTargetCount === 0 ? <span className={styles.systemStatus}>仅本机 AIH Server；在服务器设置中添加并授权其他 Server 后可切换</span> : null}
      {status?.status === 'permission-required' ? (
        <button type="button" className={styles.systemAction} onClick={() => {
          void translationAPI.requestSystemPermission().catch(() => message.error('无法打开辅助功能设置'));
        }}>去授权</button>
      ) : null}
    </div>
  );
}
