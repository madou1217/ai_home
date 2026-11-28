import { useLayoutEffect, useRef } from 'react';
import { CloseOutlined, GlobalOutlined, MinusOutlined } from '@ant-design/icons';
import BrowserView from '@/features/account-browser/BrowserView';
import styles from './office-browser-window.module.css';

type Props = {
  requiredServerId: string;
  onMinimize: () => void;
  onClose: () => void;
};

export default function OfficeBrowserWindow({ requiredServerId, onMinimize, onClose }: Props) {
  const windowRef = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    const element = windowRef.current;
    element?.focus({ preventScroll: true });
    return () => {
      // Minimize/close unmounts BrowserView: no hidden focus, input queue or live controller remains.
      const active = document.activeElement;
      if (active instanceof HTMLElement && element?.contains(active)) active.blur();
    };
  }, []);

  return <section ref={windowRef} className={styles.window} role="dialog" aria-label="任务浏览器窗口"
    tabIndex={-1} onKeyDown={(event) => { if (event.key === 'Escape') event.stopPropagation(); }}>
    <header className={styles.titlebar}>
      <div className={styles.title}><GlobalOutlined /><span>任务浏览器</span></div>
      <span className={styles.status}>恢复后需手动启动 · 尚未绑定账号</span>
      <div className={styles.actions}>
        <button type="button" className={styles.action} onClick={onMinimize}
          aria-label="最小化任务浏览器窗口" title="最小化并释放浏览器控制连接，恢复后需手动启动">
          <MinusOutlined />
        </button>
        <button type="button" className={styles.action} onClick={onClose}
          aria-label="关闭任务浏览器窗口" title="关闭窗口并释放浏览器控制连接">
          <CloseOutlined />
        </button>
      </div>
    </header>
    <div className={styles.content}>
      <BrowserView requiredServerId={requiredServerId} embedded />
    </div>
  </section>;
}
