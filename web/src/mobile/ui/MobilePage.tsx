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

export function MobileToolbar({ children, start }: { children?: ReactNode; start?: ReactNode }) {
  return (
    <div className="mhud-toolbar">
      <div className="mhud-toolbar__start">{start}</div>
      <div className="mhud-toolbar__end">{children}</div>
    </div>
  );
}
