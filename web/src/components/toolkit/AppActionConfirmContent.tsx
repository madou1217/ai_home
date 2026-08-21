import { useState } from 'react';
import { CodeOutlined, EyeInvisibleOutlined } from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import {
  formatAppActionPlan,
  type AppActionPlanPresentation
} from '@/features/app-install/app-install-presentation';
import './AppActionConfirmContent.css';

interface AppActionConfirmContentProps {
  summary: string;
  plans: AppActionPlanPresentation[];
  metadata?: Array<{ label: string; value: string }>;
}

/** 安装确认默认只展示意图，命令详情按需展开，避免长脚本淹没关键操作。 */
export default function AppActionConfirmContent({
  summary,
  plans,
  metadata = []
}: AppActionConfirmContentProps) {
  const [detailsOpen, setDetailsOpen] = useState(false);

  return (
    <div className="app-action-confirm-content">
      <p>{summary}</p>
      {metadata.length ? (
        <dl className="app-action-confirm-content__metadata">
          {metadata.map((item) => (
            <div key={item.label}>
              <dt>{item.label}</dt>
              <dd>{item.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      <Button
        type="text"
        size="small"
        icon={detailsOpen ? <EyeInvisibleOutlined /> : <CodeOutlined />}
        aria-expanded={detailsOpen}
        onClick={() => setDetailsOpen((current) => !current)}
      >
        {detailsOpen ? '收起命令详情' : '查看命令详情'}
      </Button>
      {detailsOpen ? (
        <div className="app-action-confirm-content__plans">
          {plans.length ? plans.map((plan) => (
            <section key={plan.id}>
              <strong>{plan.label || plan.id}</strong>
              <pre><code>{formatAppActionPlan(plan)}</code></pre>
            </section>
          )) : (
            <span className="app-action-confirm-content__empty">该操作由应用生命周期服务执行，没有可展示的命令。</span>
          )}
        </div>
      ) : null}
    </div>
  );
}
