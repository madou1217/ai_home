import { memo, useEffect, useState, useMemo, useRef } from 'react';
import { history } from '@umijs/max';
import {
  SearchOutlined,
  MessageOutlined,
  AppstoreOutlined,
  LineChartOutlined,
  ControlOutlined,
  SettingOutlined,
  ClearOutlined,
  RocketOutlined,
  BgColorsOutlined,
} from '@ant-design/icons';
import styles from './chat.module.css';

interface Props {
  open: boolean;
  onClose: () => void;
  onSelectModel?: (model: string) => void;
  onClearContext?: () => void;
}

interface CommandItem {
  id: string;
  title: string;
  category: '导航' | '快捷操作' | '模型切换';
  icon: any;
  action: () => void;
  shortcut?: string;
}

export const GlobalCommandPalette = memo(function GlobalCommandPalette({
  open,
  onClose,
  onSelectModel,
  onClearContext,
}: Props) {
  const [search, setSearch] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setSearch('');
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  const commands: CommandItem[] = useMemo(() => [
    {
      id: 'nav-chat',
      title: '前往 AI 会话 (Chat)',
      category: '导航',
      icon: <MessageOutlined />,
      action: () => { history.push('/ui/chat'); onClose(); },
      shortcut: '1',
    },
    {
      id: 'nav-accounts',
      title: '前往 账号管理 (Accounts)',
      category: '导航',
      icon: <AppstoreOutlined />,
      action: () => { history.push('/ui/accounts'); onClose(); },
      shortcut: '2',
    },
    {
      id: 'nav-models',
      title: '前往 模型目录 (Models)',
      category: '导航',
      icon: <ControlOutlined />,
      action: () => { history.push('/ui/models'); onClose(); },
      shortcut: '3',
    },
    {
      id: 'nav-usage',
      title: '前往 用量监控 (Usage)',
      category: '导航',
      icon: <LineChartOutlined />,
      action: () => { history.push('/ui/usage'); onClose(); },
      shortcut: '4',
    },
    {
      id: 'nav-settings',
      title: '前往 系统设置 (Settings)',
      category: '导航',
      icon: <SettingOutlined />,
      action: () => { history.push('/ui/settings'); onClose(); },
      shortcut: '5',
    },
    {
      id: 'act-theme',
      title: '切换流光主题 (深色 / 浅色)',
      category: '快捷操作',
      icon: <BgColorsOutlined />,
      action: () => {
        const root = document.documentElement;
        const isDark = root.getAttribute('data-theme') === 'dark';
        root.setAttribute('data-theme', isDark ? 'light' : 'dark');
        try {
          import('@/services/cross-tab-session-sync').then((m) =>
            m.crossTabSync.broadcast('THEME_CHANGED', { theme: isDark ? 'light' : 'dark' })
          );
        } catch {}
        onClose();
      },
      shortcut: 'Cmd+T',
    },
    {
      id: 'act-clear',
      title: '清空会话上下文 (/clear)',
      category: '快捷操作',
      icon: <ClearOutlined />,
      action: () => {
        if (onClearContext) {
          onClearContext();
        }
        onClose();
      },
    },
  ], [onClearContext, onClose]);

  const filtered = useMemo(() => {
    if (!search.trim()) return commands;
    const q = search.toLowerCase().trim();
    return commands.filter((c) =>
      c.title.toLowerCase().includes(q) || c.category.toLowerCase().includes(q)
    );
  }, [commands, search]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!open) return;
      if (e.key === 'Escape') {
        onClose();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((prev) => (prev + 1) % (filtered.length || 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((prev) => (prev - 1 + (filtered.length || 1)) % (filtered.length || 1));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (filtered[selectedIndex]) {
          filtered[selectedIndex].action();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [filtered, onClose, open, selectedIndex]);

  if (!open) return null;

  return (
    <div className={styles.commandPaletteOverlay} onClick={onClose}>
      <div className={styles.commandPaletteCard} onClick={(e) => e.stopPropagation()}>
        <div className={styles.commandPaletteInputWrapper}>
          <SearchOutlined className={styles.commandPaletteSearchIcon} />
          <input
            ref={inputRef}
            className={styles.commandPaletteInput}
            placeholder="搜索全局页面、执行指令或切换模型..."
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setSelectedIndex(0);
            }}
          />
          <kbd className={styles.commandPaletteKbd}>ESC</kbd>
        </div>

        <div className={styles.commandPaletteList}>
          {filtered.length === 0 ? (
            <div className={styles.commandPaletteEmpty}>无匹配的全局指令</div>
          ) : (
            filtered.map((item, idx) => {
              const isSelected = idx === selectedIndex;
              return (
                <div
                  key={item.id}
                  className={`${styles.commandPaletteItem} ${isSelected ? styles.commandPaletteItemSelected : ''}`}
                  onMouseEnter={() => setSelectedIndex(idx)}
                  onClick={() => item.action()}
                >
                  <span className={styles.commandPaletteItemIcon}>{item.icon}</span>
                  <span className={styles.commandPaletteItemTitle}>{item.title}</span>
                  <span className={styles.commandPaletteItemCategory}>{item.category}</span>
                  {item.shortcut && <kbd className={styles.commandPaletteItemKbd}>{item.shortcut}</kbd>}
                </div>
              );
            })
          )}
        </div>

        <div className={styles.commandPaletteFooter}>
          <span>↑↓ 导航</span>
          <span>↵ 确认执行</span>
          <span>ESC 退出</span>
        </div>
      </div>
    </div>
  );
});

export default GlobalCommandPalette;
