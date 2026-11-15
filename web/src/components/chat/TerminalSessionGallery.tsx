import { useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import styles from './terminal-session-gallery.module.css';

export interface GalleryTab { id: string; label: string; status: string }

function TerminalSurface({ tab, active, attach, select, close }: {
  tab: GalleryTab; active: boolean;
  attach: (id: string, node: HTMLDivElement, active: boolean) => void;
  select: (id: string) => void;
  close?: (id: string) => void;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const mount = useRef<HTMLDivElement>(null);
  const [geometry, setGeometry] = useState({ width: 1152, height: 648, scale: 1 });
  useLayoutEffect(() => {
    const node = mount.current;
    const host = viewport.current;
    if (!node || !host) return;
    attach(tab.id, node, active);
    const measure = () => {
      const screen = node.querySelector<HTMLElement>('.xterm-screen');
      const width = screen?.offsetWidth || 1152;
      const height = screen?.offsetHeight || 648;
      const scale = Math.min(host.clientWidth / width, host.clientHeight / height, 1);
      setGeometry((old) => old.width === width && old.height === height && old.scale === scale ? old : { width, height, scale });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    const screen = node.querySelector<HTMLElement>('.xterm-screen');
    if (screen) observer.observe(screen);
    measure();
    return () => observer.disconnect();
  }, [active, attach, tab.id]);
  const style: CSSProperties | undefined = active ? undefined : {
    width: geometry.width, height: geometry.height,
    transform: `scale(${geometry.scale})`,
  };
  return <section className={`${styles.surface} ${active ? styles.main : styles.preview}`} data-session-id={tab.id} data-terminal-tab={tab.id} data-terminal-role={active ? 'main' : 'preview'}>
    <div className={styles.caption}>
      <span className={styles.dot} data-status={tab.status} />
      <span className={styles.label} title={tab.label}>{tab.label}</span>
      <span className={styles.status}>{active ? '当前控制' : tab.status === 'ready' ? '实时预览' : tab.status === 'connecting' ? '连接中' : tab.status === 'closed' ? '已结束' : '连接异常'}</span>
      {close ? <button type="button" className={styles.close} aria-label={`关闭 ${tab.label} 的视图`} title="关闭此终端视图" onClick={() => close(tab.id)}>×</button> : null}
    </div>
    <div ref={viewport} className={styles.viewport}>
      <div ref={mount} className={styles.mount} style={style} />
    </div>
    {!active ? <button type="button" className={styles.select} aria-label={`切换到 ${tab.label}`} title={`切换到 ${tab.label}`} onClick={() => select(tab.id)} /> : null}
  </section>;
}

export default function TerminalSessionGallery({ tabs, activeId, attach, select, close }: {
  tabs: GalleryTab[]; activeId: string;
  attach: (id: string, node: HTMLDivElement, active: boolean) => void;
  select: (id: string) => void;
  close?: (id: string) => void;
}) {
  const active = tabs.find((tab) => tab.id === activeId) || tabs[0];
  const previews = tabs.filter((tab) => tab.id !== active?.id);
  return <div className={styles.gallery}>
    {active ? <TerminalSurface key={active.id} tab={active} active attach={attach} select={select} close={close} /> : null}
    {previews.length ? <aside className={styles.rail} style={{ '--terminal-preview-count': previews.length } as CSSProperties} aria-label="其他会话实时预览">
      {previews.map((tab) => <TerminalSurface key={tab.id} tab={tab} active={false} attach={attach} select={select} close={close} />)}
    </aside> : null}
  </div>;
}
