import type { ReactNode } from 'react';

interface Props {
  title?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}

/** 空状态：「NO SIGNAL」式线框 + 说明 + 可选主操作。只描述真实空数据，不放示例数据。 */
export default function EmptySignal({ title = '暂无数据', description, action }: Props) {
  return (
    <div className="mhud-empty" role="status">
      <span className="mhud-empty__frame" aria-hidden="true">
        <span />
      </span>
      <span className="mhud-empty__title">{title}</span>
      {description ? <span className="mhud-empty__desc">{description}</span> : null}
      {action ? <div className="mhud-empty__action">{action}</div> : null}
    </div>
  );
}
