import { CheckOutlined, DownOutlined, UserOutlined } from '@ant-design/icons';
import { Dropdown } from 'antd';
import type { MenuProps } from 'antd';
import ProviderIcon from '../ProviderIcon';
import { getProviderLabel } from '@/providers/catalog';
import styles from './composer-controls.module.css';

export interface ComposerAccountOption {
  readonly id: string;
  readonly label: string;
  readonly badge?: string;
  readonly provider?: string;
}

interface Props {
  readonly value: string;
  readonly options: readonly ComposerAccountOption[];
  readonly disabled?: boolean;
  readonly onChange: (id: string) => void;
}

export default function ComposerAccountMenu(props: Props) {
  const current = props.options.find((option) => option.id === props.value);
  const accountItem = (option: ComposerAccountOption) => ({
    key: option.id,
    onClick: () => props.onChange(option.id),
    label: (
      <span className={styles.optionRow}>
        <span className={styles.optionMain}>
          {option.provider ? <ProviderIcon provider={option.provider} size={16} /> : <UserOutlined />}
          <span>{option.label}</span>
          {option.badge ? <small>{option.badge}</small> : null}
        </span>
        {option.id === props.value ? <CheckOutlined /> : null}
      </span>
    ),
  });
  const groups = new Map<string, ComposerAccountOption[]>();
  props.options.forEach((option) => {
    const provider = option.provider || '';
    const group = groups.get(provider) || [];
    group.push(option);
    groups.set(provider, group);
  });
  const items: MenuProps['items'] = [...groups].flatMap(([provider, options]) => provider ? [{
    type: 'group' as const,
    key: `provider:${provider}`,
    label: <span className={styles.optionMain} data-account-provider={provider}>
      <ProviderIcon provider={provider} size={16} />
      <span>{getProviderLabel(provider)}{provider === 'codex' ? ' / Codex' : ''}</span>
    </span>,
    children: options.map(accountItem),
  }] : options.map(accountItem));

  return (
    <Dropdown trigger={['click']} menu={{ items, style: { maxHeight: 'min(480px, 70vh)', overflowY: 'auto' } }}
      disabled={props.disabled || items.length === 0}>
      <button type="button" className={styles.controlButton} aria-label="选择运行账号">
        {current?.provider ? <ProviderIcon provider={current.provider} size={16} /> : <UserOutlined />}
        <span className={styles.controlValue}>{current?.label || '选择账号'}</span>
        {current?.badge ? <small>{current.badge}</small> : null}
        <DownOutlined className={styles.chevron} />
      </button>
    </Dropdown>
  );
}
