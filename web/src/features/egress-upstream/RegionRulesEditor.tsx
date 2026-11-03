import { useEffect, useState } from 'react';
import { Empty, Form, Input, Modal, Radio, Select, Tag, Tooltip } from 'antd';
import { ArrowDownOutlined, ArrowUpOutlined, DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import { EDITABLE_MATCH_FIELDS, MATCH_FIELD_LABELS, emptyMatch, summarizeRule } from './egress-upstream-presentation';
import type { EgressMatchField, EgressRule } from './types';

export type RuleDraft = Pick<EgressRule, 'effect' | 'match' | 'note'> & { id?: string };

interface RegionRulesEditorProps {
  rules: EgressRule[];
  saving: boolean;
  onSave: (rules: RuleDraft[]) => void;
  /** 外部（例如「据此加规则」）预填的新规则；变化时打开编辑框。 */
  seed: RuleDraft | null;
  onSeedConsumed: () => void;
}

const PLACEHOLDERS: Record<EgressMatchField, string> = {
  country: '国家/地区码，如 HK、CN、RU（回车添加）',
  region: '省/州，如 California、Guangdong',
  city: '城市，如 Hong Kong、Shanghai',
  asn: 'ASN，如 AS4134',
  cidr: 'IPv4 段，如 203.0.113.0/24',
  nodes: '',
  groups: ''
};

/**
 * 上游地区规则编辑：按顺序求值、首条命中生效；同一字段内是「或」，不同字段之间是「且」。
 * 规则匹配的是出口的**真实位置**（查询出口 IP 归属），不是节点名。
 */
export default function RegionRulesEditor({ rules, saving, onSave, seed, onSeedConsumed }: RegionRulesEditorProps) {
  const [editing, setEditing] = useState<{ index: number; draft: RuleDraft } | null>(null);
  const [form] = Form.useForm<RuleDraft>();

  useEffect(() => {
    if (!seed) return;
    setEditing({ index: -1, draft: seed });
    onSeedConsumed();
  }, [seed, onSeedConsumed]);

  useEffect(() => {
    if (editing) form.setFieldsValue({ effect: editing.draft.effect, note: editing.draft.note, match: { ...emptyMatch(), ...editing.draft.match } });
  }, [editing, form]);

  const commit = (next: RuleDraft[]) => onSave(next.map((rule) => ({ id: rule.id, effect: rule.effect, match: rule.match, note: rule.note })));
  const move = (index: number, delta: number) => {
    const next = rules.slice();
    const [item] = next.splice(index, 1);
    next.splice(index + delta, 0, item);
    commit(next);
  };

  const submit = async () => {
    const values = await form.validateFields();
    const match = { ...emptyMatch(), ...(values.match || {}) };
    const hasAny = EDITABLE_MATCH_FIELDS.some((field) => (match[field] || []).length > 0);
    if (!hasAny) {
      form.setFields([{ name: ['match', 'country'], errors: ['至少填写一个匹配条件'] }]);
      return;
    }
    const draft: RuleDraft = { id: editing?.draft.id, effect: values.effect, note: values.note || '', match };
    const next: RuleDraft[] = rules.slice();
    if (editing && editing.index >= 0) next[editing.index] = draft;
    else next.unshift(draft);
    commit(next);
    setEditing(null);
  };

  return (
    <div className="egress-up-rules">
      <div className="egress-up-section-head">
        <strong>地区规则</strong>
        <small>按顺序求值，首条命中生效；规则优先于实测与预置提示</small>
        <Button size="small" icon={<PlusOutlined />} onClick={() => setEditing({ index: -1, draft: { effect: 'deny', match: emptyMatch(), note: '' } })}>
          新增规则
        </Button>
      </div>
      {rules.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有自定义规则：按实测与预置提示判定" />
      ) : (
        <ol className="egress-up-rule-list">
          {rules.map((rule, index) => (
            <li key={rule.id} data-effect={rule.effect}>
              <Tag color={rule.effect === 'deny' ? 'error' : 'success'}>{rule.effect === 'deny' ? '拒绝' : '允许'}</Tag>
              <span className="egress-up-rule-text">
                {summarizeRule(rule).replace(/^(允许|拒绝) · /, '')}
                {rule.note ? <small>{rule.note}</small> : null}
              </span>
              <span className="egress-up-rule-actions">
                <Tooltip title="上移"><Button size="small" icon={<ArrowUpOutlined />} disabled={index === 0 || saving} onClick={() => move(index, -1)} aria-label="上移规则" /></Tooltip>
                <Tooltip title="下移"><Button size="small" icon={<ArrowDownOutlined />} disabled={index === rules.length - 1 || saving} onClick={() => move(index, 1)} aria-label="下移规则" /></Tooltip>
                <Tooltip title="编辑"><Button size="small" icon={<EditOutlined />} disabled={saving} onClick={() => setEditing({ index, draft: rule })} aria-label="编辑规则" /></Tooltip>
                <Tooltip title="删除"><Button size="small" danger icon={<DeleteOutlined />} disabled={saving} onClick={() => commit(rules.filter((_, i) => i !== index))} aria-label="删除规则" /></Tooltip>
              </span>
            </li>
          ))}
        </ol>
      )}
      <Modal
        open={Boolean(editing)}
        title={editing && editing.index >= 0 ? '编辑地区规则' : '新增地区规则'}
        okText="保存规则"
        confirmLoading={saving}
        onOk={() => void submit()}
        onCancel={() => setEditing(null)}
        destroyOnHidden
      >
        <Form form={form} layout="vertical">
          <Form.Item name="effect" label="效果">
            <Radio.Group optionType="button" buttonStyle="solid" options={[{ value: 'deny', label: '拒绝' }, { value: 'allow', label: '允许' }]} />
          </Form.Item>
          {EDITABLE_MATCH_FIELDS.map((field) => (
            <Form.Item key={field} name={['match', field]} label={MATCH_FIELD_LABELS[field]}>
              <Select mode="tags" tokenSeparators={[',', '，']} placeholder={PLACEHOLDERS[field]} open={false} aria-label={MATCH_FIELD_LABELS[field]} />
            </Form.Item>
          ))}
          <Form.Item name="note" label="备注（显示在判定原因里）">
            <Input maxLength={200} placeholder="例如：Anthropic 不接受香港出口" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
