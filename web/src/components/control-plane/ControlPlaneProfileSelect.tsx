import { useEffect, useId, useMemo, useState } from 'react';
import type { ChangeEvent } from 'react';
import {
  addActiveControlPlaneProfileChangeListener,
  resolveActiveControlPlaneProfile,
  resolveStoredActiveControlPlaneProfile,
  selectActiveControlPlaneProfile,
  syncStoredActiveControlPlaneProfile
} from '@/services/control-plane-selection';
import {
  addControlPlaneProfilesChangeListener,
  isControlPlaneProfileReady,
  listControlPlaneProfiles,
  summarizeControlPlaneProfileNodes
} from '@/services/control-plane-profiles';
import type { ControlPlaneProfile } from '@/types';
import styles from './ControlPlaneProfileSelect.module.css';

type ControlPlaneProfileSelectSize = 'default' | 'compact';
const DEFAULT_MANAGE_HREF = '/ui/fabric/control-planes';

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
  const nodeSummary = summarizeControlPlaneProfileNodes(profile);
  const nodeSuffix = nodeSummary.total > 0 ? ` · ${nodeSummary.online}/${nodeSummary.total} 在线` : '';
  if (profile.authState === 'paired' && profile.state !== 'degraded') return `${name}${nodeSuffix}`;
  const state = profile.state === 'degraded'
    ? '异常'
    : profile.state === 'revoked'
      ? '已撤销'
      : '未配对';
  return `${name} (${state}${nodeSuffix})`;
}

function getProfileSummaryLabel(profile: ControlPlaneProfile | null) {
  if (!profile) return '';
  const nodeSummary = summarizeControlPlaneProfileNodes(profile);
  const chunks: string[] = [];
  if (nodeSummary.total > 0) chunks.push(`${nodeSummary.online}/${nodeSummary.total} 在线`);
  if (profile.schedulableAccountCount > 0) chunks.push(`${profile.schedulableAccountCount} 可调度`);
  return chunks.join(' · ');
}

function resolveProfileSelection(profiles: ControlPlaneProfile[], activeProfileId?: string) {
  return activeProfileId
    ? resolveActiveControlPlaneProfile(profiles, activeProfileId).profileId
    : resolveStoredActiveControlPlaneProfile(profiles).profileId;
}

export default function ControlPlaneProfileSelect({
  id,
  activeProfileId = '',
  label = '服务器',
  ariaLabel = '切换 Control Plane 服务器',
  disabled = false,
  size = 'default',
  className,
  selectClassName,
  manageHref = DEFAULT_MANAGE_HREF,
  manageLabel = '管理',
  emptyLabel = '配对服务器',
  showManageLink = true,
  showSummary = false,
  testId = 'control-plane-profile-select',
  onChange
}: ControlPlaneProfileSelectProps) {
  const generatedId = useId();
  const selectId = id || `control-plane-profile-${generatedId.replace(/:/g, '')}`;
  const [profiles, setProfiles] = useState<ControlPlaneProfile[]>(() => listControlPlaneProfiles());
  const [selectedProfileId, setSelectedProfileId] = useState(() => (
    resolveProfileSelection(listControlPlaneProfiles(), activeProfileId)
  ));

  const selectedProfile = useMemo(() => (
    profiles.find((profile) => profile.id === selectedProfileId) || null
  ), [profiles, selectedProfileId]);
  const selectedProfileSummary = getProfileSummaryLabel(selectedProfile);

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
    return () => {
      eventTarget?.removeEventListener('focus', handleRefresh);
      unsubscribe();
      unsubscribeProfiles();
    };
  }, [activeProfileId]);

  const renderManageLink = (label: string) => (
    showManageLink ? (
      <a className={styles.manageLink} href={manageHref}>
        {label}
      </a>
    ) : null
  );

  if (profiles.length === 0) {
    return (
      <div
        className={joinClassNames(styles.root, size === 'compact' && styles.compact, className)}
      >
        <span className={joinClassNames(styles.statusDot, styles.statusAttention)} aria-hidden="true" />
        {label ? <span className={styles.label}>{label}</span> : null}
        {renderManageLink(emptyLabel)}
      </div>
    );
  }

  const handleChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const resolution = selectActiveControlPlaneProfile(profiles, event.currentTarget.value);
    setSelectedProfileId(resolution.profileId);
    onChange?.(resolution.profile, resolution.profileId);
  };

  return (
    <div
      className={joinClassNames(styles.root, size === 'compact' && styles.compact, className)}
      title={selectedProfile?.endpoint || undefined}
    >
      <span
        className={joinClassNames(
          styles.statusDot,
          isControlPlaneProfileReady(selectedProfile) ? styles.statusReady : styles.statusAttention
        )}
        aria-hidden="true"
      />
      {label ? (
        <label className={styles.label} htmlFor={selectId}>
          {label}
        </label>
      ) : null}
      <select
        id={selectId}
        className={joinClassNames(styles.select, selectClassName)}
        value={selectedProfileId}
        onChange={handleChange}
        disabled={disabled || profiles.length < 2}
        aria-label={ariaLabel}
        data-testid={testId}
      >
        {profiles.map((profile) => (
          <option key={profile.id} value={profile.id}>
            {getProfileLabel(profile)}
          </option>
        ))}
      </select>
      {showSummary && selectedProfileSummary ? (
        <span className={styles.summary}>
          {selectedProfileSummary}
        </span>
      ) : null}
      {renderManageLink(manageLabel)}
    </div>
  );
}
