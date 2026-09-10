import { memo } from 'react';
import { Modal } from 'antd';
import { ThunderboltOutlined } from '@ant-design/icons';
import styles from './chat-overlays.module.css';

export interface ShortcutEntry {
  key: string;
  description: string;
  category: '导航与中枢' | '会话交互' | '编辑器快捷键';
}

// 纪律:这里的每一行都必须在 chat-global-shortcuts.ts 有对应实现。
// Cmd+T(新标签)/Cmd+N(新窗口)是浏览器保留键,页面不可拦截,已从手册移除——
// 主题切换走 Cmd+K 命令面板,新对话走会话列表「+」。
const SHORTCUTS: ShortcutEntry[] = [
  { key: 'Cmd + K', description: '调起全局命令中枢 (Command Palette)', category: '导航与中枢' },
  { key: 'Cmd + F', description: '调起会话内悬浮关键词检索胶囊', category: '会话交互' },
  { key: 'Cmd + /', description: '查看快捷键与交互指南', category: '导航与中枢' },
  { key: '/', description: '触发 Slash 快捷指令浮层菜单', category: '编辑器快捷键' },
  { key: '@', description: '触发工作区工程文件树动态引用', category: '编辑器快捷键' },
  { key: 'Enter', description: '发送消息 / 确认选中', category: '编辑器快捷键' },
  { key: 'Shift + Enter', description: '编辑器内换行', category: '编辑器快捷键' },
  { key: 'Esc', description: '关闭当前浮层 / 退出全屏沙箱', category: '导航与中枢' },
];

export interface KeyboardShortcutsModalProps {
  open: boolean;
  onClose: () => void;
}

/**
 * HarmonyOS 6 风格全站快捷键指南与效率卡片
 * 通透亚克力材质、微曲率连续圆角与灵动键盘键帽 (Kbd)
 */
export const KeyboardShortcutsModal = memo(function KeyboardShortcutsModal({
  open,
  onClose,
}: KeyboardShortcutsModalProps) {
  const categories = ['导航与中枢', '会话交互', '编辑器快捷键'] as const;

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      width={560}
      centered
      title={
        <div className={styles.shortcutsModalTitle}>
          <ThunderboltOutlined /> 键盘快捷键与效率指南
        </div>
      }
      className={styles.shortcutsModal}
    >
      <div className={styles.shortcutsModalBody}>
        {categories.map((cat) => (
          <div key={cat} className={styles.shortcutsGroup}>
            <div className={styles.shortcutsGroupTitle}>{cat}</div>
            <div className={styles.shortcutsGroupList}>
              {SHORTCUTS.filter((s) => s.category === cat).map((s) => (
                <div key={s.key} className={styles.shortcutRow}>
                  <span className={styles.shortcutDesc}>{s.description}</span>
                  <kbd className={styles.shortcutKbd}>{s.key}</kbd>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
});

export default KeyboardShortcutsModal;
