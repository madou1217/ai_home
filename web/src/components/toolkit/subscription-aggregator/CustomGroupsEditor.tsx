import { Collapse, Form, Popconfirm, Space, Tag, Typography } from 'antd';
import type { FormInstance } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import CustomGroupFields from './CustomGroupFields';
import { countGroupReferences, createCustomGroup, describeGroupRemoval, matchGroupNodes, removeGroupReferences } from './custom-groups';
import type { AggregatorCatalog, AggregatorCustomGroup, AggregatorDraftNode, AggregatorProfileInput, AggregatorSource } from './types';
import styles from './SubscriptionAggregator.module.css';

const { Text } = Typography;

interface CustomGroupsEditorProps {
  form: FormInstance<AggregatorProfileInput>;
  catalog: AggregatorCatalog;
  sources: AggregatorSource[];
  nodes: AggregatorDraftNode[] | null;
  nodesError: string;
  /** 展开的组 id（保存校验失败时由抽屉展开出错的组） */
  expanded: string[];
  onExpandedChange: (ids: string[]) => void;
}

/**
 * 自建策略组列表：每个组一个折叠面板，标题显示策略与成员概况；新建的组直接展开。
 * 删除时一并清理引用（其它组的套用、规则组默认策略、自定义规则、漏网之鱼）。
 */
export default function CustomGroupsEditor({ form, catalog, sources, nodes, nodesError, expanded, onExpandedChange }: CustomGroupsEditorProps) {
  const groups = (Form.useWatch(['groups', 'custom'], form) as AggregatorCustomGroup[] | undefined) || [];
  const typeName = (type: string) => catalog.groupTypes.find((item) => item.id === type)?.name || type;

  const summary = (group: AggregatorCustomGroup) => {
    const parts = [];
    if (group.members?.length) parts.push(`套用 ${group.members.length} 个组`);
    if (nodes) {
      const match = matchGroupNodes(group.nodes, nodes);
      if (match.nodes.length) parts.push(`${match.nodes.length} 个节点`);
    }
    return parts.length ? parts.join(' · ') : '还没有成员（会用直连占位）';
  };

  const removeGroup = (index: number, groupId: string, remove: (index: number) => void) => {
    const rules = form.getFieldValue(['rules']) as AggregatorProfileInput['rules'] | undefined;
    remove(index);
    onExpandedChange(expanded.filter((id) => id !== groupId));
    if (!rules) return;
    const cleaned = removeGroupReferences(groups, rules, groupId, catalog.presets);
    cleaned.groups.forEach((group, position) => form.setFieldValue(['groups', 'custom', position, 'members'], group.members));
    form.setFieldValue(['rules', 'presets'], cleaned.rules.presets);
    form.setFieldValue(['rules', 'custom'], cleaned.rules.custom);
    form.setFieldValue(['rules', 'finalPolicy'], cleaned.rules.finalPolicy);
  };

  return (
    <Form.List name={['groups', 'custom']}>
      {(fields, { add, remove }) => (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          {fields.length > 0 && (
            <Collapse
              activeKey={expanded}
              onChange={(keys) => onExpandedChange(Array.isArray(keys) ? keys.map(String) : [String(keys)])}
              items={fields.map((field) => {
                const group = groups[field.name];
                const groupId = group?.id || String(field.key);
                const rules = form.getFieldValue(['rules']) as AggregatorProfileInput['rules'] | undefined;
                const references = group && rules ? describeGroupRemoval(countGroupReferences(groups, rules, group.id)) : '';
                return {
                  key: groupId,
                  forceRender: true,
                  label: (
                    <span className={styles.groupHeader}>
                      <strong>{group?.name?.trim() || '未命名策略组'}</strong>
                      <Tag bordered={false}>{typeName(group?.type || 'select')}</Tag>
                      {group ? <Text type="secondary">{summary(group)}</Text> : null}
                    </span>
                  ),
                  extra: (
                    <Popconfirm
                      title={`删除「${group?.name || '这个策略组'}」？`}
                      description={references || undefined}
                      okText="删除"
                      okButtonProps={{ danger: true }}
                      onConfirm={(event) => {
                        event?.stopPropagation();
                        removeGroup(field.name, groupId, remove);
                      }}
                      onCancel={(event) => event?.stopPropagation()}
                    >
                      <Button
                        type="text"
                        size="small"
                        icon={<DeleteOutlined />}
                        aria-label={`删除策略组 ${group?.name || ''}`}
                        onClick={(event) => event.stopPropagation()}
                      />
                    </Popconfirm>
                  ),
                  children: group ? (
                    <CustomGroupFields
                      form={form}
                      field={field}
                      group={group}
                      groups={groups}
                      catalog={catalog}
                      sources={sources}
                      nodes={nodes}
                      nodesError={nodesError}
                    />
                  ) : null
                };
              })}
            />
          )}
          <Button
            type="dashed"
            block
            icon={<PlusOutlined />}
            onClick={() => {
              const group = createCustomGroup(groups);
              add(group);
              onExpandedChange([...expanded, group.id]);
            }}
          >
            新建策略组
          </Button>
        </Space>
      )}
    </Form.List>
  );
}
