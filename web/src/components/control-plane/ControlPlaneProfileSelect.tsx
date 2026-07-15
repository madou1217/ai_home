import { useEffect, useMemo, useState } from 'react';
import { Dropdown, message } from 'antd';
import { CloudServerOutlined, DesktopOutlined, DownOutlined, SettingOutlined } from '@ant-design/icons';
import {
  addActiveControlPlaneProfileChangeListener,
  resolveActiveControlPlaneProfile,
  resolveStoredActiveControlPlaneProfile,
  selectActiveControlPlaneProfileSecure,
  syncStoredActiveControlPlaneProfile
} from '@/services/control-plane-selection';
import {
  addControlPlaneProfilesChangeListener,
  isControlPlaneProfileReady,
  listControlPlaneProfiles,
  syncSharedControlPlaneProfiles
} from '@/services/control-plane-profiles';
import type { ControlPlaneProfile } from '@/types';
import { buildAppHref } from '@/services/app-navigation';
import styles from './ControlPlaneProfileSelect.module.css';

type ControlPlaneProfileSelectSize = 'default' | 'compact';
const DEFAULT_MANAGE_HREF = buildAppHref('/fabric/servers');

interface ControlPlaneProfileSelectProps {
  id?: string;
  activeProfileId?: string;
  label?: string;
  ariaLabel?: string;
  disabled?: boolean;
  size?: ControlPlaneProfileSelectSize;
  className?: string;
  selectClassName?: string;
  manageHref?: string;
  manageLabel?: string;
  emptyLabel?: string;
  showManageLink?: boolean;
  showSummary?: boolean;
  testId?: string;
  onChange?: (profile: ControlPlaneProfile | null, profileId: string) => void;
}

function joinClassNames(...items: Array<string | undefined | false>) {
  return items.filter(Boolean).join(' ');
}

function getWindowEventTarget() {
  if (typeof window === 'undefined') return null;
  if (typeof window.addEventListener !== 'function') return null;
  if (typeof window.removeEventListener !== 'function') return null;
  return window;
}

function getProfileLabel(profile: ControlPlaneProfile) {
  const name = String(profile.name || profile.endpoint || profile.id).trim();
  if (profile.state === 'ready') return name;
  const state = profile.state === 'degraded'
    ? '异常'
    : '离线';
  return `${name} (${state})`;
}

function isLocalProfileEndpoint(endpoint?: string) {
  if (typeof window === 'undefined') return false;
  try {
    const target = new URL(String(endpoint || ''));
    const origin = new URL(window.location.origin);
    const norm = (host: string) => (host === 'localhost' || host === '::1' || host === '[::1]' ? '127.0.0.1' : host);
    return norm(target.hostname) === norm(origin.hostname);
  } catch {
    return false;
  }
}

// footer 切换器上只显示极简名：本机 / 远端·<hostname首段>，与右上角 CurrentServerBadge 一致。
function getProfileShortName(profile: ControlPlaneProfile | null) {
  if (!profile) return '未连接';
  if (isLocalProfileEndpoint(profile.endpoint)) return '本机';
  let host = String(profile.name || profile.endpoint || profile.id);
  try {
    const parsed = new URL(String(profile.endpoint || ''));
    if (parsed.hostname) host = parsed.hostname.split('.')[0] || parsed.hostname;
  } catch {
    /* 保留 fallback 名 */
  }
  return `远端 · ${host}`;
}

function resolveProfileSelection(profiles: ControlPlaneProfile[], activeProfileId?: string) {
  return activeProfileId
    ? resolveActiveControlPlaneProfile(profiles, activeProfileId).profileId
    : resolveStoredActiveControlPlaneProfile(profiles).profileId;
}

export default function ControlPlaneProfileSelect({
  activeProfileId = '',
  ariaLabel = '切换 Server',
  disabled = false,
  size = 'default',
  className,
  manageHref = DEFAULT_MANAGE_HREF,
  manageLabel = '配置服务器',
  emptyLabel = '添加 Server',
  showManageLink = true,
  testId = 'control-plane-profile-select',
  onChange
}: ControlPlaneProfileSelectProps) {
  const [profiles, setProfiles] = useState<ControlPlaneProfile[]>(() => listControlPlaneProfiles());
  const [selectedProfileId, setSelectedProfileId] = useState(() => (
    resolveProfileSelection(listControlPlaneProfiles(), activeProfileId)
  ));

  const selectedProfile = useMemo(() => (
    profiles.find((profile) => profile.id === selectedProfileId) || null
  ), [profiles, selectedProfileId]);

  useEffect(() => {
    setSelectedProfileId((current) => {
      const nextProfileId = resolveProfileSelection(profiles, activeProfileId);
      return current === nextProfileId ? current : nextProfileId;
    });
  }, [activeProfileId, profiles]);

  useEffect(() => {
    const refreshProfiles = (nextActiveProfileId = activeProfileId) => {
      const nextProfiles = listControlPlaneProfiles();
      setProfiles(nextProfiles);
      const nextProfileId = nextActiveProfileId
        ? resolveProfileSelection(nextProfiles, nextActiveProfileId)
        : syncStoredActiveControlPlaneProfile(nextProfiles).profileId;
      setSelectedProfileId(nextProfileId);
    };
    const unsubscribe = addActiveControlPlaneProfileChangeListener((detail) => {
      refreshProfiles(detail.profileId);
    });
    const unsubscribeProfiles = addControlPlaneProfilesChangeListener(() => {
      refreshProfiles();
    });
    const eventTarget = getWindowEventTarget();
    const handleRefresh = () => refreshProfiles();
    eventTarget?.addEventListener('focus', handleRefresh);
    // 全局同步共享 profile：切换器在任意页面挂载时都从 server 拉齐 profile 列表，
    // 避免"只在 Server Setup 页才同步"导致其它页只有 1 个 profile、切换器禁用。
    syncSharedControlPlaneProfiles().then(() => refreshProfiles()).catch(() => {});
    return () => {
      eventTarget?.removeEventListener('focus', handleRefresh);
      unsubscribe();
      unsubscribeProfiles();
    };
  }, [activeProfileId]);

  const renderGear = () => (
    showManageLink ? (
      <a
        className={styles.gear}
        href={manageHref}
        title={manageLabel}
        aria-label={manageLabel}
      >
        <SettingOutlined />
      </a>
    ) : null
  );

  if (profiles.length === 0) {
    return (
      <div className={joinClassNames(styles.root, size === 'compact' && styles.compact, className)}>
        <a className={styles.addLink} href={manageHref} title={emptyLabel} aria-label={emptyLabel}>
          <span className={joinClassNames(styles.statusDot, styles.statusAttention)} aria-hidden="true" />
          <span className={styles.serverName}>{emptyLabel}</span>
        </a>
        {renderGear()}
      </div>
    );
  }

  const isLocal = isLocalProfileEndpoint(selectedProfile?.endpoint);
  const canSwitch = !disabled && profiles.length >= 2;
  const menuItems = profiles.map((profile) => ({
    key: profile.id,
    icon: isLocalProfileEndpoint(profile.endpoint) ? <DesktopOutlined /> : <CloudServerOutlined />,
    label: getProfileLabel(profile)
  }));

  const handleSelect = async (nextId: string) => {
    try {
      const resolution = await selectActiveControlPlaneProfileSecure(profiles, nextId);
      setSelectedProfileId(resolution.profileId);
      onChange?.(resolution.profile, resolution.profileId);
    } catch (error) {
      const source = error as { code?: unknown; message?: unknown };
      message.error(String(source?.code || source?.message || '切换 Server 失败'));
    }
  };

  return (
    <div className={joinClassNames(styles.root, size === 'compact' && styles.compact, className)}>
      <Dropdown
        trigger={['click']}
        disabled={!canSwitch}
        placement="topLeft"
        menu={{
          items: menuItems,
          selectedKeys: [selectedProfileId],
          onClick: ({ key }) => handleSelect(String(key))
        }}
      >
        <button
          type="button"
          className={styles.trigger}
          disabled={!canSwitch}
          title={selectedProfile?.endpoint || undefined}
          aria-label={ariaLabel}
          data-testid={testId}
        >
          <span
            className={joinClassNames(
              styles.statusDot,
              isControlPlaneProfileReady(selectedProfile) ? styles.statusReady : styles.statusAttention
            )}
            aria-hidden="true"
          />
          {isLocal ? (
            <DesktopOutlined className={styles.serverIcon} />
          ) : (
            <CloudServerOutlined className={styles.serverIcon} />
          )}
          <span className={styles.serverName}>{getProfileShortName(selectedProfile)}</span>
          {canSwitch ? <DownOutlined className={styles.caret} /> : null}
        </button>
      </Dropdown>
      {renderGear()}
    </div>
  );
}
