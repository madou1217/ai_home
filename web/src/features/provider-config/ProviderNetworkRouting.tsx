import { Button, Input, Select, Switch, Tag, Tooltip } from 'antd';
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  DeleteOutlined,
  PlusOutlined
} from '@ant-design/icons';
import InlineNote from '@/components/ui/InlineNote';
import type {
  EgressRoutingAction,
  EgressRoutingPolicy,
  EgressRoutingRuleType,
  EgressRoutingTestResult
} from '@/features/egress-upstream/types';

const ROUTING_ACTION_LABELS: Record<string, string> = {
  proxy: '出口池',
  direct: '直连',
  reject: '拒绝'
};

interface ProviderNetworkRoutingProps {
  routing: EgressRoutingPolicy;
  restart: boolean;
  onRestartChange: (value: boolean) => void;
  saving: boolean;
  testTarget: string;
  onTestTargetChange: (value: string) => void;
  testResult: EgressRoutingTestResult | null;
  testing: boolean;
  status: string;
  statusTone: 'info' | 'success' | 'error';
  onUpdateRule: (index: number, patch: Partial<EgressRoutingPolicy['rules'][number]>) => void;
  onAddRule: () => void;
  onRemoveRule: (index: number) => void;
  onMoveRule: (index: number, delta: number) => void;
  onUpdateDNS: (patch: Partial<EgressRoutingPolicy['dns']>) => void;
  onTest: () => void;
  onSave: () => void;
}

export default function ProviderNetworkRouting({
  routing,
  restart,
  onRestartChange,
  saving,
  testTarget,
  onTestTargetChange,
  testResult,
  testing,
  status,
  statusTone,
  onUpdateRule,
  onAddRule,
  onRemoveRule,
  onMoveRule,
  onUpdateDNS,
  onTest,
  onSave
}: ProviderNetworkRoutingProps) {
  return (
    <section className="pn-routing" aria-label="路由与 DNS">
      <div className="pn-layer-head">
        <strong>路由与 DNS</strong>
        <span>规则按顺序匹配；proxy=当前账号车道，direct=直连，reject=拒绝。规则对 sing-box 每条车道分别生效；mihomo 内核使用全局规则，车道可能优先。</span>
      </div>
      <div className="pn-rule-list">
        {routing.rules.length ? routing.rules.map((rule, index) => (
          <div className="pn-rule-row" key={rule.id}>
            <Select
              size="small"
              value={rule.type}
              options={[
                { value: 'domain', label: '精确域名' },
                { value: 'domain-suffix', label: '域名后缀' },
                { value: 'domain-keyword', label: '域名关键词' },
                { value: 'ip-cidr', label: 'IP 段' }
              ]}
              onChange={(value) => onUpdateRule(index, { type: value as EgressRoutingRuleType })}
            />
            <Input
              size="small"
              value={rule.value}
              placeholder={rule.type === 'ip-cidr' ? '10.0.0.0/8' : 'example.com'}
              onChange={(event) => onUpdateRule(index, { value: event.target.value })}
            />
            <Select
              size="small"
              value={rule.action}
              options={[
                { value: 'proxy', label: '出口池' },
                { value: 'direct', label: '直连' },
                { value: 'reject', label: '拒绝' }
              ]}
              onChange={(value) => onUpdateRule(index, { action: value as EgressRoutingAction })}
            />
            <Tooltip title="上移">
              <Button size="small" icon={<ArrowUpOutlined />} disabled={index === 0} onClick={() => onMoveRule(index, -1)} aria-label="上移规则" />
            </Tooltip>
            <Tooltip title="下移">
              <Button size="small" icon={<ArrowDownOutlined />} disabled={index === routing.rules.length - 1} onClick={() => onMoveRule(index, 1)} aria-label="下移规则" />
            </Tooltip>
            <Tooltip title="删除">
              <Button size="small" danger icon={<DeleteOutlined />} onClick={() => onRemoveRule(index)} aria-label="删除规则" />
            </Tooltip>
          </div>
        )) : <span className="pn-muted">没有自定义规则；所有流量走出口池。</span>}
      </div>
      <div className="pn-routing-actions">
        <Button size="small" icon={<PlusOutlined />} onClick={onAddRule}>添加规则</Button>
      </div>
      <div className="pn-route-test">
        <span className="pn-layer-name">测试</span>
        <Input
          size="small"
          value={testTarget}
          placeholder="api.example.com / 10.0.0.0/8"
          onChange={(event) => onTestTargetChange(event.target.value)}
          onPressEnter={onTest}
        />
        <Button size="small" loading={testing} onClick={onTest}>测试已保存规则</Button>
        {testResult ? (
          <Tag bordered={false} color={testResult.matched ? (testResult.action === 'reject' ? 'error' : testResult.action === 'direct' ? 'default' : 'success') : 'success'}>
            {testResult.matched
              ? `${ROUTING_ACTION_LABELS[testResult.action] || testResult.action} · ${testResult.type} ${testResult.value}`
              : '未命中 · 出口池'}
          </Tag>
        ) : null}
      </div>
      <div className="pn-dns-row">
        <span className="pn-layer-name">DNS</span>
        <Select
          size="small"
          value={routing.dns.mode}
          options={[
            { value: 'default', label: '内核默认' },
            { value: 'doh', label: 'DoH' },
            { value: 'plain', label: 'UDP' }
          ]}
          onChange={(value) => onUpdateDNS({ mode: value as EgressRoutingPolicy['dns']['mode'] })}
        />
        {routing.dns.mode !== 'default' ? (
          <>
            <Input
              size="small"
              value={routing.dns.servers.join(',')}
              placeholder={routing.dns.mode === 'doh' ? 'https://1.1.1.1/dns-query' : '223.5.5.5'}
              onChange={(event) => onUpdateDNS({ servers: event.target.value.split(',').map((item) => item.trim()) })}
            />
            <Select
              size="small"
              value={routing.dns.route}
              options={[
                { value: 'proxy', label: '经出口池' },
                { value: 'direct', label: '直连' }
              ]}
              onChange={(value) => onUpdateDNS({ route: value as EgressRoutingPolicy['dns']['route'] })}
            />
          </>
        ) : null}
      </div>
      <div className="pn-routing-foot">
        <span className="pn-routing-restart">
          <Switch size="small" checked={restart} onChange={onRestartChange} /> 保存后重启出口池
        </span>
        <Button size="small" type="primary" loading={saving} onClick={onSave}>
          保存路由/DNS
        </Button>
      </div>
      {status ? (
        <InlineNote tone={statusTone === 'success' ? 'success' : statusTone === 'error' ? 'error' : 'info'}>
          {status}
        </InlineNote>
      ) : null}
    </section>
  );
}
