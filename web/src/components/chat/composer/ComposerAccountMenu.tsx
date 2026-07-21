import { CheckOutlined, DownOutlined, UserOutlined } from '@ant-design/icons';
import { Dropdown } from 'antd';
import type { MenuProps } from 'antd';
import styles from './composer-controls.module.css';

export interface ComposerAccountOption {
  readonly id: string;
  readonly label: string;
  readonly badge?: string;
}

interface Props {
  readonly value: string;
  readonly options: readonly ComposerAccountOption[];
  readonly disabled?: boolean;
  readonly onChange: (id: string) => void;
}

export default function ComposerAccountMenu(props: Props) {
  const current = props.options.find((option) => option.id === props.value);
  const items: MenuProps['items'] = props.options.map((option) => ({
    key: option.id,
    onClick: () => props.onChange(option.id),
    label: (
      <span className={styles.optionRow}>
        <span className={styles.optionMain}>
          <UserOutlined />
          <span>{option.label}</span>
          {option.badge ? <small>{option.badge}</small> : null}
        </span>
        {option.id === props.value ? <CheckOutlined /> : null}
      </span>
    ),
  }));

  return (
    <Dropdown trigger={['click']} menu={{ items }} disabled={props.disabled || items.length === 0}>
      <button type="button" className={styles.controlButton} aria-label="选择运行账号">
        <UserOutlined />
        <span className={styles.controlValue}>{current?.label || '选择账号'}</span>
        {current?.badge ? <small>{current.badge}</small> : null}
        <DownOutlined className={styles.chevron} />
      </button>
    </Dropdown>
  );
}
