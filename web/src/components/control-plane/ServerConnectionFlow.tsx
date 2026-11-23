import { memo } from 'react';
import { CheckOutlined } from '@ant-design/icons';
import SettingStatusTag from '@/components/ui/SettingStatusTag';
import {
  SERVER_LIFECYCLE_META,
  type ServerLifecycleState
} from './server-list-presentation';
import './ServerConnectionFlow.css';

export interface ServerConnectionFlowProps {
  lifecycle: ServerLifecycleState;
  detail?: string;
}

const STEPS: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'connect', label: '连接地址' },
  { key: 'probe', label: '探测凭证' },
  { key: 'save', label: '保存配置' },
  { key: 'active', label: '当前生效' }
];

function resolveStepIndex(lifecycle: ServerLifecycleState): number {
  switch (lifecycle) {
    case 'disconnected':
    case 'failed':
      return 0;
    case 'probing':
      return 1;
    case 'probed_unsaved':
      return 2;
    case 'saved_inactive':
      return 3;
    case 'active':
      return 4;
  }
}

/**
 * 紧凑 4 步连接进度条：连接地址 → 探测凭证 → 保存配置 → 当前生效。
 * 与 SettingStatusTag 同源，确保状态文本与视觉一致，无左侧装饰条。
 */
export const ServerConnectionFlow = memo(function ServerConnectionFlow({
  lifecycle,
  detail
}: ServerConnectionFlowProps) {
  const meta = SERVER_LIFECYCLE_META[lifecycle];
  const activeIndex = resolveStepIndex(lifecycle);

  return (
    <div className="cp-flow" aria-label="Server 连接流程">
      <div className="cp-flow-head">
        <span className="cp-flow-eyebrow">连接流程</span>
        <SettingStatusTag status={meta.tagStatus} label={meta.label} detail={detail} compact />
      </div>
      <ol className="cp-flow-steps">
        {STEPS.map((step, index) => {
          const done = index < activeIndex;
          const current = index === activeIndex || (lifecycle === 'active' && index === STEPS.length - 1);
          const isError = lifecycle === 'failed' && index === 1;
          return (
            <li
              key={step.key}
              className={[
                'cp-flow-step',
                done ? 'cp-flow-step--done' : '',
                current ? 'cp-flow-step--current' : '',
                isError ? 'cp-flow-step--error' : ''
              ].filter(Boolean).join(' ')}
            >
              <span className="cp-flow-step-index" aria-hidden="true">
                {done ? <CheckOutlined /> : index + 1}
              </span>
              <span className="cp-flow-step-label">{step.label}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
});

export default ServerConnectionFlow;
