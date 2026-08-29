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
} from '@ant-design/icons';
import styles from './chat.module.css';

interface Props {
  open: boolean;
  onClose: () => void;
  onSelectModel?: (model: string) => void;
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
}: Props) {
  const [search, setSearch] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setSearch('');
      setSelectedIndex(0);
      window.setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  const commands: CommandItem[] = useMemo(() => [
    {
      id: 'nav-chat',
      title: '前往 Chat 会话工作台',
      category: '导航',
      icon: <MessageOutlined />,
      action: () => { history.push('/chat'); onClose(); },
      shortcut: 'G C',
    },
    {
      id: 'nav-accounts',
      title: '前往 Accounts 账号池',
      category: '导航',
      icon: <ControlOutlined />,
      action: () => { history.push('/accounts'); onClose(); },
      shortcut: 'G A',
    },
    {
      id: 'nav-models',
      title: '前往 Models 模型清单与别名',
      category: '导航',
      icon: <AppstoreOutlined />,
      action: () => { history.push('/models'); onClose(); },
      shortcut: 'G M',
    },
    {
      id: 'nav-usage',
      title: '前往 ModelUsage 用量仪表盘',
      category: '导航',
      icon: <LineChartOutlined />,
      action: () => { history.push('/model-usage'); onClose(); },
      shortcut: 'G U',
    },
    {
      id: 'nav-settings',
      title: '前往 Settings 系统设置',
      category: '导航',
      icon: <SettingOutlined />,
      action: () => { history.push('/settings'); onClose(); },
      shortcut: 'G S',
    },
    {
      id: 'act-new-chat',
      title: '发起新对话 (Chat 纯聊天)',
      category: '快捷操作',
      icon: <RocketOutlined />,
      action: () => { history.push('/chat'); onClose(); },
      shortcut: 'Cmd+N',
    },
    {
      id: 'act-clear',
      title: '清空会话上下文 (/clear)',
      category: '快捷操作',
      icon: <ClearOutlined />,
      action: () => { onClose(); },
    },
  ], [onClose]);

  const filtered = useMemo(() => {
    if (!search.trim()) return commands;
    const q = search.toLowerCase().trim();
    return commands.filter((c) =>
      c.title.toLowerCase().includes(q) || c.category.toLowerCase().includes(q)
    );
  }, [commands, search]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [search]);

  // 全局键盘事件监听
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((idx) => (filtered.length ? (idx + 1) % filtered.length : 0));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((idx) => (filtered.length ? (idx - 1 + filtered.length) % filtered.length : 0));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const item = filtered[selectedIndex];
      if (item) item.action();
    }
  };

  if (!open) return null;

  return (
    <div className={styles.commandPaletteOverlay} onClick={onClose}>
      <div className={styles.commandPaletteCard} onClick={(e) => e.stopPropagation()}>
        <div className={styles.commandPaletteInputWrap}>
          <SearchOutlined className={styles.commandPaletteSearchIcon} />
          <input
            ref={inputRef}
            className={styles.commandPaletteInput}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="搜索指令、快速跳转页面或执行快捷操作 (↑↓ 导航 · Enter 确认 · Esc 退出)"
            aria-label="全局指令搜索"
          />
          <kbd className={styles.commandPaletteKbd}>ESC</kbd>
        </div>

        <div className={styles.commandPaletteList} role="listbox">
          {filtered.length === 0 ? (
            <div className={styles.commandPaletteEmpty}>未找到匹配的指令或操作</div>
          ) : (
            filtered.map((item, index) => {
              const active = index === selectedIndex;
              return (
                <div
                  key={item.id}
                  role="option"
                  aria-selected={active}
                  className={`${styles.commandPaletteItem} ${active ? styles.commandPaletteItemActive : ''}`}
                  onMouseEnter={() => setSelectedIndex(index)}
                  onClick={item.action}
                >
                  <span className={styles.commandItemIcon}>{item.icon}</span>
                  <span className={styles.commandItemTitle}>{item.title}</span>
                  <span className={styles.commandItemCategory}>{item.category}</span>
                  {item.shortcut ? <kbd className={styles.commandItemShortcut}>{item.shortcut}</kbd> : null}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
});

export default GlobalCommandPalette;
