import { useState } from 'react';
import { AutoComplete, Form, Input, Select, Space, Typography } from 'antd';
import type { FormInstance } from 'antd';
import { ArrowDownOutlined, ArrowUpOutlined, DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import type { buildPolicyOptions } from './aggregator-presentation';
import { parseQuickRule, RULE_SET_SUGGESTIONS, RULE_TYPE_LABELS, upsertCustomRule } from './rule-input';
import type { AggregatorProfileInput, AggregatorRuleType } from './types';
import styles from './SubscriptionAggregator.module.css';

const { Text } = Typography;

type CustomRule = AggregatorProfileInput['rules']['custom'][number];

interface CustomRulesEditorProps {
  form: FormInstance<AggregatorProfileInput>;
  ruleTypes: AggregatorRuleType[];
  policyOptions: ReturnType<typeof buildPolicyOptions>;
}

function suggestionOptions(type: AggregatorRuleType | undefined) {
  return (type ? RULE_SET_SUGGESTIONS[type] || [] : []).map((item) => ({ value: item.value, label: `${item.value} · ${item.note}` }));
}

/**
 * 自定义规则：快速添加（输入域名、网址、IP 段或 geosite:名称，自动判断类型）+ 逐条编辑与排序。
 * 规则从上到下匹配，排在内置规则之前。
 */
export default function CustomRulesEditor({ form, ruleTypes, policyOptions }: CustomRulesEditorProps) {
  const rules = (Form.useWatch(['rules', 'custom'], form) as CustomRule[] | undefined) || [];
  const [draft, setDraft] = useState('');
  const [draftPolicy, setDraftPolicy] = useState('proxy');
  const [draftError, setDraftError] = useState('');
  const parsed = parseQuickRule(draft);

  const quickAdd = () => {
    if (!draft.trim()) return;
    if (!parsed) {
      setDraftError('认不出来：填域名、网址、IP 段，或 geosite:名称 / geoip:国家代码 / keyword:关键字 / domain:完整域名');
      return;
    }
    form.setFieldValue(['rules', 'custom'], upsertCustomRule(rules, { ...parsed, policy: draftPolicy }));
    setDraft('');
    setDraftError('');
  };

  return (
    <Form.Item label="自定义规则" extra="从上到下匹配，排在所有规则组之前，先匹配先生效。">
      <div className={styles.rowList}>
        <div className={styles.quickAddRow}>
          <Input
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setDraftError('');
            }}
            onPressEnter={(event) => {
              event.preventDefault();
              quickAdd();
            }}
            status={draftError ? 'error' : undefined}
            placeholder="chatgpt.com、geosite:openai、1.1.1.0/24"
            aria-label="快速添加规则"
            suffix={parsed ? <Text type="secondary">{RULE_TYPE_LABELS[parsed.type]}</Text> : <span />}
          />
          <Select value={draftPolicy} onChange={setDraftPolicy} options={policyOptions} showSearch optionFilterProp="label" aria-label="新规则的目标策略" />
          <Button type="primary" icon={<PlusOutlined />} onClick={quickAdd}>添加</Button>
        </div>
        {draftError ? <Text type="danger">{draftError}</Text> : null}
        <Form.List name={['rules', 'custom']}>
          {(fields, { add, remove, move }) => (
            <>
              {fields.map((field, index) => {
                const type = rules[field.name]?.type;
                return (
                  <div key={field.key} className={styles.ruleRow}>
                    <Form.Item name={[field.name, 'type']} noStyle>
                      <Select options={ruleTypes.map((value) => ({ label: RULE_TYPE_LABELS[value], value }))} aria-label="规则类型" popupMatchSelectWidth={false} />
                    </Form.Item>
                    <Form.Item name={[field.name, 'value']} rules={[{ required: true, whitespace: true, message: '填写匹配值' }]} noStyle>
                      <AutoComplete
                        options={suggestionOptions(type)}
                        filterOption={(input, option) => String(option?.label || '').toLowerCase().includes(input.toLowerCase())}
                      >
                        <Input
                          placeholder={type === 'GEOSITE' || type === 'GEOIP' ? '规则集名，例如 openai、cn' : 'google.com / 1.1.1.0/24'}
                          aria-label="匹配值"
                        />
                      </AutoComplete>
                    </Form.Item>
                    <Form.Item name={[field.name, 'policy']} noStyle>
                      <Select options={policyOptions} showSearch optionFilterProp="label" aria-label="目标策略" />
                    </Form.Item>
                    {/* 排序按钮跟着规则移动，连续点击要把一条规则挪好几格：不做防重复点击。 */}
                    <Space size={0}>
                      <Button
                        type="text"
                        icon={<ArrowUpOutlined />}
                        aria-label="上移规则"
                        disabled={index === 0}
                        disableDebounce
                        onClick={() => move(index, index - 1)}
                      />
                      <Button
                        type="text"
                        icon={<ArrowDownOutlined />}
                        aria-label="下移规则"
                        disabled={index === fields.length - 1}
                        disableDebounce
                        onClick={() => move(index, index + 1)}
                      />
                      <Button type="text" icon={<DeleteOutlined />} aria-label="删除规则" onClick={() => remove(field.name)} />
                    </Space>
                  </div>
                );
              })}
              <Button type="dashed" icon={<PlusOutlined />} onClick={() => add({ type: 'DOMAIN-SUFFIX', value: '', policy: 'proxy' })}>
                添加一条空规则
              </Button>
            </>
          )}
        </Form.List>
      </div>
    </Form.Item>
  );
}
