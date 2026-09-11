import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckOutlined, DownOutlined, UserOutlined } from '@ant-design/icons';
import { Popover } from 'antd';
import ProviderIcon from '../ProviderIcon';
import { getProviderLabel } from '@/providers/catalog';
import {
  buildComposerAccountGroups,
  type ComposerAccountOption,
} from './composer-account-menu-model';
import styles from './composer-controls.module.css';

export type { ComposerAccountOption } from './composer-account-menu-model';

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
  const [open, setOpen] = useState(false);
  const currentGroupRef = useRef<HTMLElement>(null);
  const selectedOptionRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      currentGroupRef.current?.scrollIntoView({ block: 'start', inline: 'nearest' });
      selectedOptionRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, props.value]);
  const content = (
    <section className={styles.accountMenuPanel} role="dialog" aria-label="运行账号">
      <header className={styles.accountMenuHeader}>
        <strong>选择运行账号</strong>
        {props.selectionHint ? <span>{props.selectionHint}</span> : null}
      </header>
      <div className={styles.accountGroupList} role="listbox" aria-label="按 Provider 分组的运行账号">
        {groups.map((group) => {
          const headingId = `composer-account-group-${group.provider || 'other'}`;
          return (
            <section
              key={group.provider || 'other'}
              ref={group.provider === current?.provider ? currentGroupRef : undefined}
              className={styles.accountGroup}
              role="group"
              aria-labelledby={headingId}
            >
              <header
                id={headingId}
                className={styles.accountGroupHeading}
                data-account-provider={group.provider}
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
        aria-label="选择运行账号"
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={props.disabled || groups.length === 0}
      >
        {current?.provider ? <ProviderIcon provider={current.provider} size={16} /> : <UserOutlined />}
        {props.grouped && current?.provider ? (
          <span className={styles.controlProviderLabel}>
            {current.provider === 'codex' ? 'Codex' : getProviderLabel(current.provider)}
          </span>
        ) : null}
        <span className={styles.controlValue}>{current?.label || '选择账号'}</span>
        {current?.badge && !props.grouped ? <small>{current.badge}</small> : null}
        <DownOutlined className={styles.chevron} />
      </button>
    </Popover>
  );
}
