import type { ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** 页首工具条（刷新 / 新增等真实操作） */
  toolbar?: ReactNode;
  /** 页面级说明（一句话，来自原页面副标题） */
  lead?: ReactNode;
}

/** 移动端页面容器：单列、16px 边距、底部为导航栏与安全区留白。 */
export default function MobilePage({ children, toolbar, lead }: Props) {
  return (
    <div className="mhud-page">
      {toolbar ? <div className="mhud-page__toolbar">{toolbar}</div> : null}
      {lead ? <p className="mhud-page__lead">{lead}</p> : null}
      {children}
    </div>
  );
}

/* 移动端顶部页面容器：避免双空槽时出现额外 44px 空白，工具栏与首段说明紧贴 */
export function MobileToolbar({ children, start }: { children?: ReactNode; start?: ReactNode }) {
  if (!start && !children) return null;
  return (
    <div className="mhud-toolbar">
      {start ? <div className="mhud-toolbar__start">{start}</div> : null}
      {children ? <div className="mhud-toolbar__end">{children}</div> : null}
    </div>
  );
}
