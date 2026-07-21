import { CheckOutlined, DownOutlined } from '@ant-design/icons';
import { Dropdown, Spin } from 'antd';
import type { MenuProps } from 'antd';
import type { ComposerModelOption } from '@/chat-runtime';
import styles from './composer-controls.module.css';

interface Props {
  readonly models: readonly ComposerModelOption[];
  readonly model: string;
  readonly effort: string;
  readonly loading?: boolean;
  readonly error?: string;
  readonly disabled?: boolean;
  readonly onModelChange: (model: string) => void;
  readonly onEffortChange: (effort: string) => void;
  readonly onRetry?: () => void;
}

export default function ComposerModelMenu(props: Props) {
  const current = props.models.find((model) => model.id === props.model);
  const efforts = current?.supportedEfforts || [];
  const items: MenuProps['items'] = [
    {
      key: 'models',
      label: <MenuHeading label="Model" value={current?.label || 'Unavailable'} />,
      children: props.models.map((model) => ({
        key: `model:${model.id}`,
        onClick: () => props.onModelChange(model.id),
        label: <Choice label={model.label} selected={model.id === props.model} />,
      })),
    },
    ...(efforts.length > 0 ? [{
      key: 'efforts',
      label: <MenuHeading label="Effort" value={effortLabel(props.effort)} />,
      children: efforts.map((effort) => ({
        key: `effort:${effort}`,
        onClick: () => props.onEffortChange(effort),
        label: <Choice label={effortLabel(effort)} selected={effort === props.effort} />,
      })),
    }] : []),
  ];

  if (props.error) {
    items.push({
      key: 'retry',
      onClick: props.onRetry,
      label: <span className={styles.retryOption}>模型目录不可用 · 重试</span>,
    });
  }

  return (
    <Dropdown
      trigger={['click']}
      menu={{ items }}
      disabled={props.disabled || (props.loading && props.models.length === 0)}
    >
      <button type="button" className={styles.modelSummary} aria-label="选择模型与推理强度">
        {props.loading && !current ? <Spin size="small" /> : (
          <>
            <span>{current?.label || '选择模型'}</span>
            {current && props.effort ? <small>{effortLabel(props.effort)}</small> : null}
          </>
        )}
        <DownOutlined className={styles.chevron} />
      </button>
    </Dropdown>
  );
}

function MenuHeading({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <span className={styles.menuHeading}>
      <span>{label}</span>
      <span>{value}</span>
    </span>
  );
}

function Choice({ label, selected }: { readonly label: string; readonly selected: boolean }) {
  return (
    <span className={styles.optionRow}>
      <span>{label}</span>
      {selected ? <CheckOutlined /> : null}
    </span>
  );
}

export function effortLabel(value: string): string {
  return EFFORT_LABELS[value] || value.replace(/(^|[-_])([a-z])/g, (_all, _prefix, char) => ` ${char.toUpperCase()}`).trim();
}

const EFFORT_LABELS: Readonly<Record<string, string>> = {
  minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High',
  xhigh: 'Extra High', ultra: 'Ultra', max: 'Max',
};
