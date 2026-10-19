import { useMemo, useState } from 'react';
import { Empty, Input, Radio, Segmented, Select, Table, Tag, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { CheckCircleOutlined, CloseCircleOutlined, LoadingOutlined, SearchOutlined, ThunderboltOutlined } from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import InlineNote from '@/components/ui/InlineNote';
import {
  countriesOf,
  countryFlag,
  describeScopeSummary,
  describeVerdict,
  groupLabel,
  nodeInScope,
  summarizeScope
} from './egress-upstream-presentation';
import type { EgressCatalogGroup, EgressPoolScope, EgressPoolStrategy, EgressUpstream, EgressUpstreamNode } from './types';
import './EgressUpstream.css';

export interface PoolSelection {
  scope: EgressPoolScope;
  strategy: EgressPoolStrategy;
}

interface PoolScopePickerProps {
  upstream: EgressUpstream | null;
  groups: EgressCatalogGroup[];
  poolReady: boolean;
  value: PoolSelection;
  onChange: (next: PoolSelection) => void;
  probing: boolean;
  onProbe: (nodeNames: string[]) => void;
}

const STRATEGY_HINTS: Record<string, string> = {
  shared: '同上游、同范围的账号共用一条轮换',
  sticky: '同上游的账号尽量分到不同出口 IP（降低关联风险）',
  session: '该账号每开一个本地 CLI 会话就认领一个不同的出口（最多 4 个，更多会话复用）；网关请求走第一个'
};

const SUMMARY_ICON = {
  success: <CheckCircleOutlined />,
  warning: <LoadingOutlined />,
  error: <CloseCircleOutlined />
} as const;

/**
 * 出口池的节点范围选择（账号出口弹窗里，模式 = 出口池时出现）：
 *   全部节点（内置池，默认）/ 订阅聚合的自建分组（可多选）/ 自选节点；策略 共享轮换 / 账号独占。
 * 每个节点显示真实出口位置与对该账号上游的判定，被拒的节点即使选了也不会被使用（车道只放行允许的节点）。
 */
export default function PoolScopePicker({ upstream, groups, poolReady, value, onChange, probing, onProbe }: PoolScopePickerProps) {
  const [country, setCountry] = useState('');
  const [query, setQuery] = useState('');
  const nodes = upstream?.nodes || [];
  const scope = value.scope;
  const summary = useMemo(() => summarizeScope(nodes, scope), [nodes, scope]);
  // 没有单一上游（批量设置跨了多个上游）：节点按每个账号各自的上游判定，这里不汇总。
  const summaryText = !upstream
    ? { tone: 'success' as const, text: '所选账号属于不同上游：每个账号按自己上游的地区判定使用节点' }
    : scope.kind === 'nodes' && scope.nodes.length === 0
      ? { tone: 'warning' as const, text: '勾选要使用的节点（一个都不选时保存为全部节点）' }
      : describeScopeSummary(summary);
  const countries = useMemo(() => countriesOf(nodes), [nodes]);
  const visible = useMemo(() => nodes.filter((node) => {
    if (country && node.geo?.country !== country) return false;
    if (!query) return true;
    const needle = query.toLowerCase();
    return node.label.toLowerCase().includes(needle) || (node.geoText || '').toLowerCase().includes(needle);
  }), [nodes, country, query]);

  const setScope = (next: Partial<EgressPoolScope>) => onChange({ ...value, scope: { ...scope, ...next } });
  const selectedIdentities = new Set(scope.nodes);
  const inScopeNames = nodes.filter((node) => nodeInScope(node, scope)).map((node) => node.name);
  const probeTargets = scope.kind === 'nodes'
    ? inScopeNames
    : nodes.filter((node) => nodeInScope(node, scope) && !node.evidence).map((node) => node.name);

  const columns: ColumnsType<EgressUpstreamNode> = [
    {
      title: '节点',
      key: 'label',
      render: (_value, node) => <span className="egress-up-node-label">{node.label}</span>
    },
    {
      title: '真实出口',
      key: 'geo',
      width: 200,
      render: (_value, node) => node.geo?.country
        ? <span className="egress-up-geo">{countryFlag(node.geo.country)} {node.geo.country}{node.geo.city ? ` · ${node.geo.city}` : ''}</span>
        : <span className="egress-muted">查询中</span>
    },
    {
      title: '判定',
      key: 'verdict',
      width: 120,
      render: (_value, node) => {
        const verdict = describeVerdict(node.verdict);
        return (
          <Tooltip title={node.verdict.detail}>
            <Tag color={verdict.tone} className="egress-up-verdict">{verdict.label}</Tag>
          </Tooltip>
        );
      }
    }
  ];

  return (
    <div className="egress-up-picker">
      {!poolReady ? (
        <InlineNote tone="info" description="保存后 AIH 会启动出口池并查询每个节点的真实位置，之后这里会显示每个节点能否访问该账号的上游。">
          出口池还没运行
        </InlineNote>
      ) : null}
      <div className="egress-up-row">
        <span className="egress-up-row-label">节点范围</span>
        <Segmented
          value={scope.kind}
          onChange={(kind) => setScope({ kind: kind as EgressPoolScope['kind'] })}
          options={[
            { label: '全部节点', value: 'all' },
            { label: `自建分组${groups.length ? ` ${groups.length}` : ''}`, value: 'groups', disabled: groups.length === 0 },
            { label: '自选节点', value: 'nodes', disabled: nodes.length === 0 }
          ]}
        />
      </div>
      {scope.kind === 'groups' ? (
        <Select
          mode="multiple"
          allowClear
          className="egress-up-groups"
          placeholder="选择一个或多个自建分组（订阅聚合里维护）"
          value={scope.groups}
          onChange={(next) => setScope({ groups: next })}
          options={groups.map((group) => ({ value: group.id, label: groupLabel(group) }))}
          aria-label="自建分组"
        />
      ) : null}
      {scope.kind !== 'groups' && nodes.length > 0 ? (
        <div className="egress-up-nodes">
          <div className="egress-up-filter">
            <div className="egress-up-chips" role="group" aria-label="按出口国家筛选">
              <Tag.CheckableTag checked={!country} onChange={() => setCountry('')}>全部 {nodes.length}</Tag.CheckableTag>
              {countries.map((entry) => (
                <Tag.CheckableTag key={entry.code} checked={country === entry.code} onChange={(checked) => setCountry(checked ? entry.code : '')}>
                  {countryFlag(entry.code)} {entry.code} {entry.count}
                </Tag.CheckableTag>
              ))}
            </div>
            <Input
              size="small"
              allowClear
              prefix={<SearchOutlined />}
              placeholder="搜索节点"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="搜索节点"
            />
          </div>
          <Table
            size="small"
            rowKey="identity"
            className="egress-up-node-table"
            columns={columns}
            dataSource={visible}
            pagination={visible.length > 8 ? { pageSize: 8, showSizeChanger: false, size: 'small' } : false}
            rowSelection={scope.kind === 'nodes' ? {
              selectedRowKeys: scope.nodes,
              preserveSelectedRowKeys: true,
              onChange: (keys) => setScope({ nodes: keys.map(String) })
            } : undefined}
            rowClassName={(node) => (node.verdict.status === 'denied' ? 'egress-up-row-denied' : '')}
            locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有匹配的节点" /> }}
          />
          {scope.kind === 'nodes' ? (
            <div className="egress-up-select-actions">
              <Button
                size="small"
                type="link"
                onClick={() => setScope({ nodes: [...new Set([...scope.nodes, ...visible.filter((node) => node.verdict.status !== 'denied').map((node) => node.identity)])] })}
              >
                选中当前筛选里可用的
              </Button>
              <Button size="small" type="link" disabled={selectedIdentities.size === 0} onClick={() => setScope({ nodes: [] })}>
                清空
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="egress-up-row">
        <span className="egress-up-row-label">轮换策略</span>
        <Radio.Group
          value={value.strategy}
          onChange={(event) => onChange({ ...value, strategy: event.target.value })}
          optionType="button"
          buttonStyle="solid"
          size="small"
          options={[
            { value: 'shared', label: '共享轮换' },
            { value: 'sticky', label: '账号独占' },
            { value: 'session', label: '会话独占' }
          ]}
        />
        <Typography.Text type="secondary" className="egress-up-row-hint">
          {STRATEGY_HINTS[value.strategy] || STRATEGY_HINTS.shared}
        </Typography.Text>
      </div>
      <div className="egress-up-summary" data-tone={summaryText.tone} role="status">
        <span className="egress-up-summary-icon" aria-hidden="true">{SUMMARY_ICON[summaryText.tone]}</span>
        <span>{poolReady ? summaryText.text : '出口池启动后统计可用节点'}</span>
        <Tooltip title={probeTargets.length ? `经这些节点不带凭据请求一次 ${upstream?.host || '上游'}，记录能否访问` : '范围内的节点都已有实测'}>
          <Button
            size="small"
            icon={<ThunderboltOutlined />}
            loading={probing}
            disabled={!poolReady || !upstream || probeTargets.length === 0}
            onClick={() => onProbe(probeTargets.slice(0, 12))}
          >
            {scope.kind === 'nodes' ? '测试所选' : '测试未测节点'}
          </Button>
        </Tooltip>
      </div>
    </div>
  );
}
