import { CheckOutlined, DownOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import { Dropdown } from 'antd';
import type { MenuProps } from 'antd';
import styles from './composer-controls.module.css';

export type ComposerApprovalMode = 'bypass' | 'confirm' | 'plan';

interface Props {
  readonly value: ComposerApprovalMode;
  readonly disabled?: boolean;
  readonly onChange: (mode: ComposerApprovalMode) => void;
}

const OPTIONS: readonly {
  value: ComposerApprovalMode;
  label: string;
  description: string;
}[] = [
  { value: 'confirm', label: 'Approve for me', description: '仅在检测到潜在风险操作时询问' },
  { value: 'bypass', label: 'Full access', description: '不限制文件和网络访问' },
  { value: 'plan', label: 'Plan mode', description: '先完成计划，再确认是否执行' },
];

export default function ComposerApprovalMenu(props: Props) {
  const current = OPTIONS.find((option) => option.value === props.value) || OPTIONS[0];
  const items: MenuProps['items'] = OPTIONS.map((option) => ({
    key: option.value,
    onClick: () => props.onChange(option.value),
    label: (
      <span className={styles.approvalOption}>
        <span>
          <strong>{option.label}</strong>
          <small>{option.description}</small>
        </span>
        {option.value === props.value ? <CheckOutlined /> : null}
      </span>
    ),
  }));
  return (
    <Dropdown trigger={['click']} menu={{ items }} disabled={props.disabled}>
      <button type="button" className={styles.approvalButton} aria-label="选择审批模式">
        <SafetyCertificateOutlined />
        <span>{current.label}</span>
        <DownOutlined className={styles.chevron} />
      </button>
    </Dropdown>
  );
}
