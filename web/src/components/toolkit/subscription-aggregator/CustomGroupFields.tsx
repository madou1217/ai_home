import { useMemo } from 'react';
import { Form, Input, InputNumber, Radio, Select, Space, Typography } from 'antd';
import type { FormInstance, FormListFieldData } from 'antd';
import type { Rule } from 'antd/es/form';
import { buildMemberOptions, buildNodeOptions, groupNameProblem, matchGroupNodes } from './custom-groups';
import GroupUsageEditor from './GroupUsageEditor';
import type { AggregatorCatalog, AggregatorCustomGroup, AggregatorDraftNode, AggregatorProfileInput, AggregatorSource } from './types';
import styles from './SubscriptionAggregator.module.css';

const { Paragraph, Text } = Typography;

const PATTERN_RULE: Rule = {
  validator: async (_rule, value) => {
    if (!value) return;
    try {
      new RegExp(String(value), 'i');
    } catch (_error) {
      throw new Error('正则表达式无效');
    }
  }
};

interface CustomGroupFieldsProps {
  form: FormInstance<AggregatorProfileInput>;
  field: FormListFieldData;
  group: AggregatorCustomGroup;
  groups: AggregatorCustomGroup[];
  catalog: AggregatorCatalog;
  sources: AggregatorSource[];
  /** 编辑中的配置会选中的节点；null 表示还在读取 */
  nodes: AggregatorDraftNode[] | null;
  nodesError: string;
}

/** 一个自建组的设置：名称与策略 → 套用的组 → 选入的节点 → 用于哪些流量。 */
export default function CustomGroupFields({ form, field, group, groups, catalog, sources, nodes, nodesError }: CustomGroupFieldsProps) {
  const enabledRegions = (Form.useWatch(['groups', 'regions'], form) as string[] | undefined) || [];
  const perSource = Boolean(Form.useWatch(['groups', 'perSource'], form));
  const profileTestUrl = Form.useWatch(['groups', 'testUrl'], form) as string | undefined;
  const profileInterval = Form.useWatch(['groups', 'testIntervalSec'], form) as number | undefined;
  const typeInfo = catalog.groupTypes.find((type) => type.id === group.type);

  const memberOptions = useMemo(
    () => buildMemberOptions({ catalog, sources, groups, selfId: group.id, enabledRegions, includeSources: perSource, nodes }),
    [catalog, enabledRegions, group.id, groups, nodes, perSource, sources]
  );
  const nodeOptions = useMemo(() => buildNodeOptions(nodes || [], group.nodes?.names || []), [group.nodes?.names, nodes]);
  const match = useMemo(() => matchGroupNodes(group.nodes, nodes || []), [group.nodes, nodes]);

  const nameRules: Rule[] = [
    { required: true, whitespace: true, message: '请输入名称' },
    {
      validator: async (_rule, value) => {
        const custom = (form.getFieldValue(['groups', 'custom']) as AggregatorCustomGroup[] | undefined) || [];
        const problem = groupNameProblem(String(value || ''), catalog.reservedGroupNames, custom);
        if (problem) throw new Error(problem);
      }
    }
  ];

  const matchSummary = () => {
    if (nodes === null) return '正在读取节点…';
    if (match.invalid) return '正则表达式无效，暂时无法匹配';
    const missing = match.missingNames.length ? `；${match.missingNames.length} 个勾选的节点已不在订阅里` : '';
    return `选入 ${match.nodes.length} 个节点${missing}`;
  };

  return (
    <>
      <Form.Item name={[field.name, 'id']} hidden>
        <Input />
      </Form.Item>
      <Form.Item label="名称" name={[field.name, 'name']} rules={nameRules}>
        <Input maxLength={64} placeholder="例如：YouTube、AI 专用" />
      </Form.Item>
      <Form.Item label="策略" name={[field.name, 'type']} extra={typeInfo?.description}>
        <Radio.Group
          optionType="button"
          buttonStyle="solid"
          options={catalog.groupTypes.map((type) => ({ label: type.name, value: type.id }))}
        />
      </Form.Item>
      {group.type === 'load-balance' && (
        <Form.Item label="分配方式" name={[field.name, 'strategy']} initialValue="consistent-hashing">
          <Radio.Group options={catalog.loadBalanceStrategies.map((strategy) => ({ label: strategy.name, value: strategy.id }))} />
        </Form.Item>
      )}
      {group.type !== 'select' && (
        <Space size={16} wrap align="start">
          <Form.Item label="测速地址" name={[field.name, 'testUrl']} rules={[{ type: 'url', message: '请输入 http(s) 地址' }]}>
            <Input allowClear placeholder={profileTestUrl ? `沿用 ${profileTestUrl}` : '沿用这份配置的测速地址'} className={styles.groupTestUrl} />
          </Form.Item>
          <Form.Item label="测速间隔" name={[field.name, 'interval']}>
            <InputNumber min={30} max={86400} placeholder={`沿用 ${profileInterval ?? 300}`} addonAfter="秒" />
          </Form.Item>
          {group.type === 'url-test' && (
            <Form.Item
              label="切换容差"
              name={[field.name, 'tolerance']}
              initialValue={50}
              tooltip="别的成员比当前成员快超过这么多才切换，避免来回跳"
            >
              <InputNumber min={0} max={5000} addonAfter="毫秒" />
            </Form.Item>
          )}
        </Space>
      )}

      <Form.Item
        label="套用策略组"
        name={[field.name, 'members']}
        extra={group.type === 'fallback' ? '按这里的顺序依次尝试，排前面的优先。' : '可以套用地区组、内置组或其它自建组。'}
      >
        <Select mode="multiple" allowClear options={memberOptions} optionFilterProp="label" placeholder="例如 🇯🇵 日本节点" aria-label="套用策略组" />
      </Form.Item>
      <div className={styles.pairRow}>
        <Form.Item label="按名称选入节点" name={[field.name, 'nodes', 'include']} rules={[PATTERN_RULE]} tooltip="正则，不区分大小写">
          <Input allowClear placeholder="例如 IPLC|专线" />
        </Form.Item>
        <Form.Item label="排除名称" name={[field.name, 'nodes', 'exclude']} rules={[PATTERN_RULE]} tooltip="正则，不区分大小写；对勾选的节点也生效">
          <Input allowClear placeholder="例如 倍率|x[2-9]" />
        </Form.Item>
      </div>
      <Form.Item label="勾选节点" name={[field.name, 'nodes', 'names']}>
        <Select
          mode="multiple"
          allowClear
          showSearch
          optionFilterProp="label"
          maxTagCount="responsive"
          loading={nodes === null}
          options={nodeOptions}
          placeholder="搜索节点名"
          notFoundContent={nodesError || undefined}
          aria-label="勾选节点"
        />
      </Form.Item>
      <div className={styles.groupMatch}>
        <Text type={match.invalid || nodesError ? 'danger' : 'secondary'}>{nodesError || matchSummary()}</Text>
        {match.nodes.length > 0 && (
          <Paragraph type="secondary" ellipsis={{ rows: 2, expandable: true, symbol: '展开' }}>
            {match.nodes.map((node) => node.name).join('、')}
          </Paragraph>
        )}
      </div>

      <Text strong className={styles.groupSectionTitle}>用于</Text>
      <GroupUsageEditor form={form} groupId={group.id} catalog={catalog} />
    </>
  );
}
