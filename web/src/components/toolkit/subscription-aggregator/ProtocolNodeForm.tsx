import { AutoComplete, Collapse, Form, Input, InputNumber, Select, Switch } from 'antd';
import type { AggregatorProtocolForm } from './types';
import styles from './SubscriptionAggregator.module.css';

type FormField = AggregatorProtocolForm['fields'][number];

const SECTION_LABELS: Record<Exclude<FormField['section'], 'basic'>, string> = {
  transport: '传输',
  tls: 'TLS',
  advanced: '高级'
};

function control(field: FormField) {
  switch (field.control) {
    case 'secret':
      return <Input.Password autoComplete="off" />;
    case 'number':
      return <InputNumber min={0} style={{ width: '100%' }} />;
    case 'tags':
      return <Select mode="tags" options={field.options} tokenSeparators={[',']} />;
    case 'select':
      return <Select allowClear showSearch options={field.options} />;
    case 'suggest':
      return (
        <AutoComplete options={field.options?.map((option) => ({ value: String(option.value), label: option.label }))} filterOption>
          <Input autoComplete="off" />
        </AutoComplete>
      );
    default:
      return <Input autoComplete="off" />;
  }
}

function item(field: FormField) {
  return (
    <Form.Item
      key={field.key}
      label={field.label}
      name={field.key}
      valuePropName={field.control === 'switch' ? 'checked' : 'value'}
      rules={field.required ? [{ required: true, whitespace: field.control !== 'number', message: `请填写${field.label}` }] : undefined}
    >
      {field.control === 'switch' ? <Switch /> : control(field)}
    </Form.Item>
  );
}

interface ProtocolNodeFormProps {
  form: AggregatorProtocolForm;
  /** 有值的分区默认展开 */
  values: Record<string, unknown>;
}

/**
 * 按服务端的表单描述渲染一个协议的字段（放在外层 Form 里）：名称 / 服务器 / 端口和基础字段直接显示，
 * 传输、TLS、高级字段收在折叠面板里（已有值的分区展开）。
 */
export default function ProtocolNodeForm({ form, values }: ProtocolNodeFormProps) {
  const basic = form.fields.filter((field) => field.section === 'basic');
  const sections = (['transport', 'tls', 'advanced'] as const)
    .map((section) => ({ section, fields: form.fields.filter((field) => field.section === section) }))
    .filter((group) => group.fields.length);
  const filled = (fields: FormField[]) => fields.some((field) => {
    const value = values[field.key];
    return value !== undefined && value !== null && value !== '' && value !== false && !(Array.isArray(value) && !value.length);
  });

  return (
    <>
      <div className={styles.nodeFormGrid}>
        <Form.Item label="名称" name="name" rules={[{ required: true, whitespace: true, message: '请填写名称' }]}>
          <Input maxLength={128} placeholder="例如 🇯🇵 日本 自建" />
        </Form.Item>
        <Form.Item label="服务器" name="server" rules={[{ required: true, whitespace: true, message: '请填写服务器地址' }]}>
          <Input autoComplete="off" placeholder="域名或 IP" />
        </Form.Item>
        <Form.Item label="端口" name="port" rules={[{ required: true, message: '请填写端口' }]}>
          <InputNumber min={1} max={65535} style={{ width: '100%' }} />
        </Form.Item>
      </div>
      <div className={styles.nodeFormGrid}>{basic.map(item)}</div>
      {sections.length > 0 && (
        <Collapse
          size="small"
          defaultActiveKey={sections.filter((group) => filled(group.fields)).map((group) => group.section)}
          items={sections.map((group) => ({
            key: group.section,
            label: SECTION_LABELS[group.section],
            forceRender: true,
            children: <div className={styles.nodeFormGrid}>{group.fields.map(item)}</div>
          }))}
        />
      )}
    </>
  );
}
