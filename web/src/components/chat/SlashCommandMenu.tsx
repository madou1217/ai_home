import { memo, useEffect, useRef } from 'react';
import { CodeOutlined } from '@ant-design/icons';
import type { NativeSlashCommand } from '@/types';
import styles from './chat.module.css';

interface Props {
  commands: NativeSlashCommand[];
  selectedIndex: number;
  onSelect: (cmd: NativeSlashCommand) => void;
  onHoverIndex: (index: number) => void;
  visible: boolean;
}

export const SlashCommandMenu = memo(function SlashCommandMenu({
  commands,
  selectedIndex,
  onSelect,
  onHoverIndex,
  visible,
}: Props) {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!visible) return;
    const activeItem = listRef.current?.querySelector(`[data-index="${selectedIndex}"]`) as HTMLElement;
    if (activeItem) {
      activeItem.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex, visible]);

  if (!visible || commands.length === 0) return null;

  return (
    <div ref={listRef} className={styles.slashDropdownMenu} role="listbox" aria-label="Slash commands">
      <div className={styles.slashDropdownHeader}>
        <span>可用命令 ({commands.length})</span>
        <span className={styles.slashDropdownHint}>↑↓ 切换 · Tab / Enter 选择</span>
      </div>
      <div className={styles.slashDropdownViewport}>
        {commands.map((item, index) => {
          const active = index === selectedIndex;
          return (
            <button
              key={item.command}
              data-index={index}
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
