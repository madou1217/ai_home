import { useState } from 'react';
import { Checkbox, Form, Input, Select, Space, Tag, Typography } from 'antd';
import type { FormInstance } from 'antd';
import Button from '@/components/ui/AppButton';
import { assignPresetsToGroup, groupPolicy } from './custom-groups';
import { formatQuickRule, parseQuickRule, RULE_TYPE_LABELS, upsertCustomRule } from './rule-input';
import type { AggregatorCatalog, AggregatorProfileInput } from './types';
import styles from './SubscriptionAggregator.module.css';

const { Text } = Typography;

type Rules = AggregatorProfileInput['rules'];

interface GroupUsageEditorProps {
  form: FormInstance<AggregatorProfileInput>;
  groupId: string;
  catalog: Pick<AggregatorCatalog, 'presets'>;
}

/**
 * 「用于」：哪些流量默认走这个组。改的是分流规则页的同一份数据（规则组的默认策略、
 * 自定义规则、漏网之鱼），两边看到的始终一致。
 */
export default function GroupUsageEditor({ form, groupId, catalog }: GroupUsageEditorProps) {
  const rules = Form.useWatch(['rules'], form) as Rules | undefined;
  const [draft, setDraft] = useState('');
  const [draftError, setDraftError] = useState('');
  if (!rules) return null;

  const policy = groupPolicy(groupId);
  const presetIds = rules.presets.filter((preset) => preset.enabled && preset.policy === policy).map((preset) => preset.id);
  const siteRules = rules.custom.map((rule, index) => ({ rule, index })).filter(({ rule }) => rule.policy === policy);
  const parsed = parseQuickRule(draft);

  const addSite = () => {
    if (!draft.trim()) return;
    if (!parsed) {
      setDraftError('认不出来：填域名、网址、IP 段，或 geosite:名称 / geoip:国家代码 / keyword:关键字');
      return;
    }
    form.setFieldValue(['rules', 'custom'], upsertCustomRule(rules.custom, { ...parsed, policy }));
    setDraft('');
    setDraftError('');
  };

  return (
    <>
      <Form.Item label="这些规则组默认走它" extra="勾选的规则组会启用，并在客户端里默认选这个组；取消勾选恢复原来的默认策略。">
        <Select
          mode="multiple"
          allowClear
          value={presetIds}
          onChange={(ids: string[]) => form.setFieldValue(['rules', 'presets'], assignPresetsToGroup(rules.presets, ids, groupId, catalog.presets))}
          options={catalog.presets.map((preset) => ({ label: preset.name, value: preset.id }))}
          optionFilterProp="label"
          placeholder="例如 📹 YouTube、🤖 AI 服务"
          aria-label="走这个组的规则组"
        />
      </Form.Item>
      <Form.Item label="这些网站走它" extra="排在内置规则之前；也能在「分流规则」页调整。">
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          {siteRules.length > 0 && (
            <Space size={[4, 4]} wrap>
              {siteRules.map(({ rule, index }) => (
                <Tag
                  key={`${rule.type}:${rule.value}`}
                  closable
                  title={RULE_TYPE_LABELS[rule.type]}
                  onClose={(event) => {
                    event.preventDefault();
                    form.setFieldValue(['rules', 'custom'], rules.custom.filter((_rule, position) => position !== index));
                  }}
                >
                  {formatQuickRule(rule)}
                </Tag>
              ))}
            </Space>
          )}
          <Space.Compact className={styles.quickRuleInput}>
            <Input
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
                setDraftError('');
              }}
              onPressEnter={(event) => {
                event.preventDefault();
                addSite();
              }}
              status={draftError ? 'error' : undefined}
              placeholder="chatgpt.com、geosite:openai、1.1.1.0/24"
              aria-label="添加走这个组的网站"
              suffix={parsed ? <Text type="secondary">{RULE_TYPE_LABELS[parsed.type]}</Text> : <span />}
            />
            <Button onClick={addSite}>添加</Button>
          </Space.Compact>
          {draftError ? <Text type="danger">{draftError}</Text> : null}
        </Space>
      </Form.Item>
      <Form.Item>
        <Checkbox
          checked={rules.finalPolicy === policy}
          onChange={(event) => form.setFieldValue(['rules', 'finalPolicy'], event.target.checked ? policy : 'proxy')}
        >
          其余流量（漏网之鱼）也默认走它
        </Checkbox>
      </Form.Item>
    </>
  );
}
