import { useState } from 'react';
import { Input, Select } from 'antd';
import { CodeOutlined, EyeInvisibleOutlined } from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import Reveal from '@/components/ui/Reveal';
import {
  formatAppActionPlan,
  type AppActionPlanPresentation
} from '@/features/app-install/app-install-presentation';
import './AppActionConfirmContent.css';

export interface AppActionProxyOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface AppActionProxySelection {
  options: AppActionProxyOption[];
  value: string;
  onChange: (value: string) => void;
}

interface AppActionConfirmContentProps {
  summary: string;
  plans: AppActionPlanPresentation[];
  metadata?: Array<{ label: string; value: string }>;
  proxy?: AppActionProxySelection;
}

const CUSTOM_PROXY_VALUE = '__custom_proxy__';

/** 安装确认默认只展示意图，命令详情按需展开，避免长脚本淹没关键操作。 */
export default function AppActionConfirmContent({
  summary,
  plans,
  metadata = [],
  proxy
}: AppActionConfirmContentProps) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [proxyChoice, setProxyChoice] = useState(() => {
    const initial = proxy?.value || '';
    return initial.includes('://') ? CUSTOM_PROXY_VALUE : initial;
  });
  const [customProxy, setCustomProxy] = useState(() => {
    const initial = proxy?.value || '';
    return initial.includes('://') ? initial : '';
  });

  const selectProxy = (value: string) => {
    setProxyChoice(value);
    proxy?.onChange(value);
  };
  const changeCustomProxy = (value: string) => {
    setCustomProxy(value);
    if (proxyChoice === CUSTOM_PROXY_VALUE) proxy?.onChange(value);
  };
  const proxyOptions = [
    { value: '', label: '继承当前环境（不指定）' },
    { value: 'auto', label: '自动选择可用代理（auto）' },
    ...(proxy?.options || []),
    { value: CUSTOM_PROXY_VALUE, label: '自定义 HTTP(S) 代理…' }
  ];

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
      {proxy ? (
        <div className="app-action-confirm-content__proxy">
          <span className="app-action-confirm-content__proxy-label">安装 / 更新代理</span>
          <Select
            value={proxyChoice}
            options={proxyOptions}
            onChange={(value) => {
              if (value === CUSTOM_PROXY_VALUE) {
                selectProxy(customProxy);
              } else {
                selectProxy(value);
              }
            }}
          />
          {proxyChoice === CUSTOM_PROXY_VALUE ? (
            <Input
              value={customProxy}
              placeholder="http://user:pass@127.0.0.1:8080"
              onChange={(event) => changeCustomProxy(event.target.value)}
            />
          ) : null}
          <span className="app-action-confirm-content__proxy-hint">
            仅本次任务使用；不会修改服务端全局代理池或系统代理。
          </span>
        </div>
      ) : null}
      <Button
        type="text"
        size="small"
        icon={detailsOpen ? <EyeInvisibleOutlined /> : <CodeOutlined />}
        aria-expanded={detailsOpen}
        disableDebounce
        onClick={() => setDetailsOpen((current) => !current)}
      >
        {detailsOpen ? '收起命令详情' : '查看命令详情'}
      </Button>
      <Reveal open={detailsOpen}>
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
      </Reveal>
    </div>
  );
}
