import { memo, type CSSProperties, type ReactNode } from 'react';
import './SettingSection.css';

export interface SettingSectionProps {
  /** 分组标题 */
  title: ReactNode;
  /** 最多一句简短说明 */
  description?: ReactNode;
  /** 标题行右侧状态位（通常放置 SettingStatusTag） */
  status?: ReactNode;
  /** 标题行额外操作（可选） */
  extra?: ReactNode;
  /** 底部操作栏（通常放置 SaveActionBar） */
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}

export interface SettingRowProps {
  /** 设置项名称 */
  title: ReactNode;
  /** 最多一句简短说明 */
  description?: ReactNode;
  /** 关联控件 id（渲染 label 语义以增强可访问性） */
  htmlFor?: string;
  /** 已持久化值回显（如“已保存：95%”），与草稿控件区分 */
  persistedValue?: ReactNode;
  /** 次要说明/极少见限制（单行弱化文案） */
  caveat?: ReactNode;
  /** 行级状态位（如 SettingStatusTag） */
  status?: ReactNode;
  /** 控件槽位 */
  control: ReactNode;
  /** 控件较宽（如多行文本、复合输入）时采用纵向排布 */
  layout?: 'inline' | 'stacked';
  /** 危险操作样式 */
  danger?: boolean;
  className?: string;
  style?: CSSProperties;
}

/**
 * 紧凑设置分组容器：复用 HUD 切角面板与 1px 控件分隔线。
 * 不使用大块 Alert 或左侧彩色装饰条。
 */
export const SettingSection = memo(function SettingSection({
  title,
  description,
  status,
  extra,
  footer,
  children,
  className,
  style
}: SettingSectionProps) {
  const normalizedTitle = typeof title === 'string' ? title.trim() : null;
  const normalizedDesc = typeof description === 'string' ? description.trim() : null;
  const showDescription = Boolean(description) && (!normalizedTitle || !normalizedDesc || normalizedDesc !== normalizedTitle);
  return (
    <section
      className={['hos-setting-section', 'hud-panel', className].filter(Boolean).join(' ')}
      style={style}
    >
      <header className="hos-setting-section-head">
        <div className="hos-setting-section-heading">
          <div className="hos-setting-section-title-row">
            <h2 className="hos-setting-section-title">{title}</h2>
            {status ? <span className="hos-setting-section-status">{status}</span> : null}
          </div>
          {showDescription ? <p className="hos-setting-section-desc">{description}</p> : null}
        </div>
        {extra ? <div className="hos-setting-section-extra">{extra}</div> : null}
      </header>
      <div className="hos-setting-section-body">{children}</div>
      {footer ? <footer className="hos-setting-section-footer">{footer}</footer> : null}
    </section>
  );
});

/**
 * 紧凑设置行：标题 + 最多一行说明 + 已持久化值回显（可选）+ 状态位 + 控件槽。
 * 相邻 SettingRow 之间仅使用 1px 发丝分隔线区分边界。
 */
export const SettingRow = memo(function SettingRow({
  title,
  description,
  htmlFor,
  persistedValue,
  caveat,
  status,
  control,
  layout = 'inline',
  danger = false,
  className,
  style
}: SettingRowProps) {
  const normalizedTitle = typeof title === 'string' ? title.trim() : null;
  const normalizedDesc = typeof description === 'string' ? description.trim() : null;
  const showDescription = Boolean(description) && (!normalizedTitle || !normalizedDesc || normalizedDesc !== normalizedTitle);
  return (
    <div
      className={[
        'hos-setting-row',
        layout === 'stacked' ? 'hos-setting-row--stacked' : '',
        className
      ].filter(Boolean).join(' ')}
      style={style}
    >
      <div className="hos-setting-row-meta">
        <div className="hos-setting-row-title-line">
          {htmlFor ? (
            <label
              htmlFor={htmlFor}
              className={`hos-setting-row-title${danger ? ' hos-setting-row-title--danger' : ''}`}
            >
              {title}
            </label>
          ) : (
            <span className={`hos-setting-row-title${danger ? ' hos-setting-row-title--danger' : ''}`}>
              {title}
            </span>
          )}
          {status ? <span className="hos-setting-row-status">{status}</span> : null}
        </div>
        {showDescription ? <p className="hos-setting-row-desc">{description}</p> : null}
        {persistedValue ? <div className="hos-setting-row-persisted">{persistedValue}</div> : null}
        {caveat ? <p className="hos-setting-row-caveat">{caveat}</p> : null}
      </div>
      <div className="hos-setting-row-control">{control}</div>
    </div>
  );
});

export default SettingSection;
