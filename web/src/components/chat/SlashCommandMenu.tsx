import { memo, useEffect, useRef } from 'react';
import { CodeOutlined } from '@ant-design/icons';
import type { NativeSlashCommand } from '@/types';
import { useCollapsePresence } from '@/hooks/use-collapse-presence';
import { useFlipReorder } from '@/hooks/use-flip-reorder';
import styles from './composer/composer.module.css';

interface Props {
  commands: NativeSlashCommand[];
  selectedIndex: number;
  onSelect: (cmd: NativeSlashCommand) => void;
  onHoverIndex: (index: number) => void;
  visible: boolean;
}

const MENU_EXIT_MS = 140;

export const SlashCommandMenu = memo(function SlashCommandMenu({
  commands,
  selectedIndex,
  onSelect,
  onHoverIndex,
  visible,
}: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const open = visible && commands.length > 0;
  // 关闭时父级会清空 commands，退场期间继续展示最后一次的内容
  const lastCommandsRef = useRef(commands);
  if (open) lastCommandsRef.current = commands;
  const { present } = useCollapsePresence(open, MENU_EXIT_MS);
  const viewportFlipRef = useFlipReorder<HTMLDivElement>(open ? commands : undefined);
  const shown = open ? commands : lastCommandsRef.current;

  useEffect(() => {
    if (!open) return;
    const activeItem = listRef.current?.querySelector(`[data-index="${selectedIndex}"]`) as HTMLElement;
    if (activeItem) {
      activeItem.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex, open]);

  if (!present || shown.length === 0) return null;

  return (
    <div
      ref={listRef}
      className={`${styles.slashDropdownMenu}${open ? '' : ` ${styles.slashDropdownClosing}`}`}
      data-state={open ? 'open' : 'closing'}
      role="listbox"
      aria-label="Slash commands"
      aria-hidden={open ? undefined : true}
    >
      <div className={styles.slashDropdownHeader}>
        <span>可用命令 ({shown.length})</span>
        <span className={styles.slashDropdownHint}>↑↓ 切换 · Tab / Enter 选择</span>
      </div>
      <div ref={viewportFlipRef} className={styles.slashDropdownViewport}>
        {shown.map((item, index) => {
          const active = index === selectedIndex;
          return (
            <button
              key={item.command}
              data-index={index}
              data-flip-key={item.command}
              type="button"
              role="option"
              aria-selected={active}
              className={`${styles.slashDropdownItem} ${active ? styles.slashDropdownItemActive : ''}`}
              onMouseEnter={() => onHoverIndex(index)}
              onMouseDown={(e) => {
                e.preventDefault(); // 阻止输入框失焦
                onSelect(item);
              }}
            >
              <div className={styles.slashItemIcon}>
                <CodeOutlined />
              </div>
              <div className={styles.slashItemContent}>
                <div className={styles.slashItemMain}>
                  <span className={styles.slashItemName}>{item.command}</span>
                  {item.argumentHint ? (
                    <span className={styles.slashItemHint}>{item.argumentHint}</span>
                  ) : null}
                </div>
                <div className={styles.slashItemDesc}>
                  {item.description}
                  {item.aliases.length > 0 ? (
                    <span className={styles.slashItemAliases}>（别名: {item.aliases.join(', ')}）</span>
                  ) : null}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
});

export default SlashCommandMenu;
