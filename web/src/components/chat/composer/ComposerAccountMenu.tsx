import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckOutlined, DeploymentUnitOutlined, DownOutlined, UserOutlined } from '@ant-design/icons';
import { Popover } from 'antd';
import ProviderIcon from '../ProviderIcon';
import { getProviderFamily, getProviderMenuLabel } from '@/providers/catalog';
import {
  buildComposerAccountGroups,
  type ComposerAccountOption,
} from './composer-account-menu-model';
import styles from './composer-controls.module.css';

export type { ComposerAccountOption } from './composer-account-menu-model';

const COMPACT_MEDIA_QUERY = '(max-width: 640px)';

interface Props {
  readonly value: string;
  readonly options: readonly ComposerAccountOption[];
  readonly disabled?: boolean;
  readonly grouped?: boolean;
  readonly selectionHint?: string;
  readonly onChange: (id: string) => void;
}

export default function ComposerAccountMenu(props: Props) {
  const current = props.options.find((option) => option.id === props.value);
  const groups = useMemo(() => buildComposerAccountGroups(props.options), [props.options]);
  const currentFamily = current?.provider ? getProviderFamily(current.provider) : '';
  const [open, setOpen] = useState(false);
  const [compact, setCompact] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia(COMPACT_MEDIA_QUERY).matches;
  });
  const currentGroupRef = useRef<HTMLElement>(null);
  const selectedOptionRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mediaQuery = window.matchMedia(COMPACT_MEDIA_QUERY);
    const updateCompact = (event?: MediaQueryListEvent) => {
      setCompact(event ? event.matches : mediaQuery.matches);
    };
    updateCompact();
    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', updateCompact);
      return () => mediaQuery.removeEventListener('change', updateCompact);
    }
    mediaQuery.addListener(updateCompact);
    return () => mediaQuery.removeListener(updateCompact);
  }, []);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      currentGroupRef.current?.scrollIntoView({ block: 'start', inline: 'nearest' });
      selectedOptionRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, props.value]);

  const fullLabel = current?.label || '选择账号';
  const displayLabel = compact
    ? (current?.compactLabel || current?.label || '选择账号')
    : fullLabel;

  const content = (
    <section className={styles.accountMenuPanel} role="dialog" aria-label="运行账号">
      <header className={styles.accountMenuHeader}>
        <strong>选择运行账号</strong>
        {props.selectionHint ? <span>{props.selectionHint}</span> : null}
      </header>
      <div className={styles.accountGroupList} role="listbox" aria-label="按产品分组的运行账号">
        {groups.map((group) => {
          const headingId = `composer-account-group-${group.family || 'other'}`;
          return (
            <section
              key={group.family || 'other'}
              ref={group.family === currentFamily ? currentGroupRef : undefined}
              className={styles.accountGroup}
              role="group"
              aria-labelledby={headingId}
            >
              <header
                id={headingId}
                className={styles.accountGroupHeading}
                data-account-provider={group.provider}
                data-account-family={group.family}
              >
                {group.provider ? <ProviderIcon provider={group.provider} size={18} /> : <UserOutlined />}
                <strong>{group.label}</strong>
                <span>{group.options.length} 个账号</span>
              </header>
              <div className={styles.accountOptionList}>
                {group.options.map((option) => (
                  <button
                    key={option.id}
                    ref={option.id === props.value ? selectedOptionRef : undefined}
                    type="button"
                    className={styles.accountOptionButton}
                    role="option"
                    aria-selected={option.id === props.value}
                    onClick={() => {
                      setOpen(false);
                      props.onChange(option.id);
                    }}
                  >
                    <span className={styles.accountOptionIdentity} title={option.label}>{option.label}</span>
                    {/* 族内合并后，同一产品的国内站/国际站账号必须能分辨。 */}
                    {option.siteLabel ? <small data-account-site={option.provider}>{option.siteLabel}</small> : null}
                    {option.badge ? <small>{option.badge}</small> : null}
                    <CheckOutlined className={styles.accountOptionCheck} />
                  </button>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </section>
  );

  return (
    <Popover
      content={content}
      trigger="click"
      placement="top"
      open={open}
      onOpenChange={setOpen}
      overlayClassName={styles.accountMenuOverlay}
    >
      <button
        type="button"
        className={styles.controlButton}
        data-grouped={props.grouped || undefined}
        data-compact={compact || undefined}
        title={fullLabel}
        aria-label={`选择运行账号：${fullLabel}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={props.disabled || groups.length === 0}
      >
        {current?.badge === 'Gateway' ? <DeploymentUnitOutlined /> : current?.provider ? <ProviderIcon provider={current.provider} size={16} /> : <UserOutlined />}
        {props.grouped && current?.provider && current.badge !== 'Gateway' ? (
          <span className={styles.controlProviderLabel}>
            {current.provider === 'codex' ? 'Codex' : getProviderMenuLabel(current.provider)}
          </span>
        ) : null}
        <span className={styles.controlValue} title={fullLabel}>{displayLabel}</span>
        {current?.badge && !props.grouped ? <small>{current.badge}</small> : null}
        <DownOutlined className={styles.chevron} />
      </button>
    </Popover>
  );
}
