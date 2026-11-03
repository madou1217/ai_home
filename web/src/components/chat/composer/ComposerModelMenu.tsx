import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckOutlined, DownOutlined, SearchOutlined } from '@ant-design/icons';
import { Input, Popover, Spin } from 'antd';
import type { ComposerModelOption } from '@/chat-runtime';
import BrainIcon from './BrainIcon';
import {
  buildComposerModelGroups,
  COMPOSER_MODEL_CHIPS,
  type ComposerModelChip,
} from './composer-model-menu-model';
import styles from './composer-controls.module.css';

interface Props {
  readonly models: readonly ComposerModelOption[];
  readonly model: string;
  readonly effort: string;
  readonly loading?: boolean;
  readonly error?: string;
  readonly disabled?: boolean;
  readonly grouped?: boolean;
  /**
   * 当前目标是不是 OpenCode 目录（决定是否显示 免费/Zen/Go 芯片与分组）。
   * 由调用方按**选中的目标**判定，不能从模型列表内容反推 —— aih-server 是全量网关
   * 目录，必然含 opencode 命名空间模型，按内容判断会给跨 provider 目录套上 OpenCode
   * 专属分组（2026-10-21 真机反馈）。
   */
  readonly openCodeCatalog?: boolean;
  readonly onModelChange: (model: string) => void;
  readonly onEffortChange: (effort: string) => void;
  readonly onRetry?: () => void;
}

/**
 * 模型目录可能上百条（opencode 账号 123 条），平铺菜单只能靠滚动翻。
 * 这里换成与账号菜单同构的受控面板：搜索 + 分组芯片（免费/Zen/Go）+ 分组滚动列表，
 * 打开时自动滚到当前模型，回车直接选中第一个命中项。
 */
export default function ComposerModelMenu(props: Props) {
  const current = props.models.find((model) => model.id === props.model);
  const efforts = current?.supportedEfforts || [];
  // 分组开关来自**选中目标**（调用方判定），不来自目录内容：见 Props.openCodeCatalog。
  const opencodeCatalog = props.openCodeCatalog === true;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [chip, setChip] = useState<ComposerModelChip>('all');
  const groups = useMemo(
    () => buildComposerModelGroups(props.models, { query, chip, openCodeCatalog: opencodeCatalog }),
    [props.models, query, chip, opencodeCatalog],
  );
  const matchedCount = groups.reduce((total, group) => total + group.models.length, 0);
  const firstMatch = groups[0]?.models[0];
  const selectedRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      selectedRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, props.model, matchedCount]);
  const blocked = props.disabled || (props.loading && props.models.length === 0);
  const handleOpenChange = (next: boolean) => {
    // 每次打开都回到「全部 + 空搜索」：上一次的筛选不该污染下一次查找。
    if (next) { setQuery(''); setChip('all'); }
    setOpen(next);
  };

  const content = (
    <section className={styles.modelMenuPanel} role="dialog" aria-label="选择模型与推理强度">
      <header className={styles.modelMenuHeader}>
        <strong>选择模型</strong>
        <span>{matchedCount === props.models.length ? `${props.models.length} 个可选` : `命中 ${matchedCount} / ${props.models.length}`}</span>
      </header>
      <div className={styles.modelSearchRow}>
        <Input
          size="small"
          allowClear
          autoFocus
          prefix={<SearchOutlined />}
          placeholder="搜索模型…"
          aria-label="搜索模型"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onPressEnter={() => {
            if (!firstMatch) return;
            setOpen(false);
            props.onModelChange(firstMatch.id);
          }}
        />
        {opencodeCatalog ? (
          <div className={styles.modelChips} role="group" aria-label="模型分组">
            {COMPOSER_MODEL_CHIPS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className={styles.modelChip}
                aria-pressed={chip === entry.id}
                onClick={() => setChip(entry.id)}
              >
                {entry.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <div className={styles.modelGroupList} role="listbox" aria-label="模型列表">
        {groups.length === 0 ? <p className={styles.modelEmpty}>没有匹配的模型</p> : null}
        {groups.map((group) => {
          const headingId = `composer-model-group-${group.id}`;
          return (
            <section key={group.id} className={styles.modelGroup} role="group" aria-labelledby={headingId}>
              <header id={headingId} className={styles.modelGroupHeading}>
                <strong>{group.label}</strong>
                <span>{group.models.length}</span>
              </header>
              <div className={styles.modelOptionList}>
                {group.models.map((model) => (
                  <button
                    key={model.id}
                    ref={model.id === props.model ? selectedRef : undefined}
                    type="button"
                    className={styles.modelOptionButton}
                    role="option"
                    aria-selected={model.id === props.model}
                    title={model.id}
                    onClick={() => {
                      setOpen(false);
                      props.onModelChange(model.id);
                    }}
                  >
                    <span className={styles.modelOptionLabel}>{model.label}</span>
                    <CheckOutlined className={styles.modelOptionCheck} />
                  </button>
                ))}
              </div>
            </section>
          );
        })}
      </div>
      {efforts.length > 0 ? (
        <section className={styles.modelEffortGroup} role="group" aria-labelledby="composer-model-effort-heading">
          <header id="composer-model-effort-heading" className={styles.modelGroupHeading}>
            <strong>推理强度</strong>
            <span>{effortLabel(props.effort)}</span>
          </header>
          <div className={styles.modelOptionList}>
            {efforts.map((effort) => (
              <button
                key={effort}
                type="button"
                className={styles.modelOptionButton}
                role="option"
                aria-selected={effort === props.effort}
                onClick={() => props.onEffortChange(effort)}
              >
                <span className={styles.modelOptionLabel}>{effortLabel(effort)}</span>
                <CheckOutlined className={styles.modelOptionCheck} />
              </button>
            ))}
          </div>
        </section>
      ) : null}
      {props.error ? (
        <button type="button" className={styles.modelRetryRow} onClick={props.onRetry}>
          模型目录不可用 · 重试
        </button>
      ) : null}
    </section>
  );

  return (
    <Popover
      content={content}
      trigger="click"
      placement="top"
      open={open && !blocked}
      onOpenChange={handleOpenChange}
      overlayClassName={styles.modelMenuOverlay}
    >
      <button
        type="button"
        className={styles.modelSummary}
        data-grouped={props.grouped || undefined}
        aria-label="选择模型与推理强度"
        aria-haspopup="dialog"
        aria-expanded={open && !blocked}
        title={current?.label || '选择模型'}
        disabled={blocked}
      >
        <BrainIcon className={styles.modelIcon} />
        {props.loading && !current ? <Spin size="small" /> : (
          <>
            <span className={styles.modelLabel}>{current?.label || '选择模型'}</span>
            {current && props.effort ? <small className={styles.modelEffort}>{effortLabel(props.effort)}</small> : null}
          </>
        )}
        <DownOutlined className={styles.chevron} />
      </button>
    </Popover>
  );
}

export function effortLabel(value: string): string {
  return EFFORT_LABELS[value] || value.replace(/(^|[-_])([a-z])/g, (_all, _prefix, char) => ` ${char.toUpperCase()}`).trim();
}

const EFFORT_LABELS: Readonly<Record<string, string>> = {
  minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High',
  xhigh: 'Extra High', ultra: 'Ultra', max: 'Max',
};
