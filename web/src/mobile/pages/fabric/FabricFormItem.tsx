import { Form } from 'antd';
import type { FormItemProps } from 'antd';
import type { ReactNode } from 'react';
import { HudField } from '@/mobile/ui';
import styles from './fabric.module.css';

interface Props {
  name: FormItemProps['name'];
  label: ReactNode;
  hint?: ReactNode;
  required?: boolean;
  rules?: FormItemProps['rules'];
  children: ReactNode;
}

/**
 * HudField（大写标签 + 说明）包一层 antd Form.Item：校验规则与错误提示仍由 antd Form 负责，
 * 与桌面表单共用同一套 rules / 文案。
 */
export default function FabricFormItem({ name, label, hint, required, rules, children }: Props) {
  return (
    <HudField label={label} hint={hint} required={required}>
      <Form.Item name={name} rules={rules} className={styles.formItem}>
        {children}
      </Form.Item>
    </HudField>
  );
}
