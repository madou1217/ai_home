import { Button, Grid, Space } from 'antd';
import type { ReactNode } from 'react';

/**
 * 页面头部操作区：桌面端是带文案的按钮，手机端收成纯图标。
 *
 * 手机 390px 下，带文案的头部按钮会把标题挤成省略号（Fabric 各页实测为
 * 「Server …」「SSH 开…」）。账号页早就用「图标按钮 + .m-header-actions」解决过，
 * 但那段 JSX 写死在页面里无法复用；这里把它抽成描述式 API，让各页只声明动作。
 */
export interface PageHeaderAction {
  key: string;
  /** 手机端作为 aria-label，桌面端作为按钮文案 */
  label: string;
  icon: ReactNode;
  onClick?: () => void;
  primary?: boolean;
  disabled?: boolean;
  loading?: boolean;
  /** 需要自定义触发器（如 Popover 包裹）时，用它替换按钮本体 */
  render?: (node: ReactNode, isMobile: boolean) => ReactNode;
  /** 该动作在手机端是否隐藏——次要动作可让位给标题 */
  hideOnMobile?: boolean;
}

/** 纯判定：手机端隐去标记为 hideOnMobile 的次要动作，桌面端全量展示。 */
export function selectVisibleActions(
  actions: PageHeaderAction[],
  isMobile: boolean,
): PageHeaderAction[] {
  return isMobile ? actions.filter((action) => !action.hideOnMobile) : actions;
}

export default function PageHeaderActions({ actions }: { actions: PageHeaderAction[] }) {
  const screens = Grid.useBreakpoint();
  const isMobile = !screens.md;

  if (isMobile) {
    const visible = selectVisibleActions(actions, true);
    return (
      <div className="m-header-actions">
        {visible.map((action) => {
          const node = (
            <button
              key={action.key}
              type="button"
              className={action.primary ? 'm-icon-btn primary' : 'm-icon-btn'}
              aria-label={action.label}
              disabled={action.disabled || action.loading}
              onClick={action.onClick}
            >
              {action.icon}
            </button>
          );
          return action.render ? (
            <span key={action.key}>{action.render(node, true)}</span>
          ) : (
            node
          );
        })}
      </div>
    );
  }

  return (
    <Space size={8} wrap>
      {selectVisibleActions(actions, false).map((action) => {
        const node = (
          <Button
            key={action.key}
            type={action.primary ? 'primary' : 'default'}
            icon={action.icon}
            disabled={action.disabled}
            loading={action.loading}
            onClick={action.onClick}
          >
            {action.label}
          </Button>
        );
        return action.render ? (
          <span key={action.key}>{action.render(node, false)}</span>
        ) : (
          node
        );
      })}
    </Space>
  );
}
