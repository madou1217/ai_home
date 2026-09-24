import { useState } from 'react';
import { Segmented, Select, Space, Spin, Tooltip } from 'antd';
import InlineNote from '@/components/ui/InlineNote';
import '@/components/ui/kpi-strip.css';
import {
  ExportOutlined,
  ForkOutlined,
  GlobalOutlined,
  ImportOutlined,
  LinkOutlined,
  PlusOutlined,
  SettingOutlined,
  ThunderboltOutlined
} from '@ant-design/icons';
import { StatisticCard } from '@ant-design/pro-components';
import Button from '@/components/ui/AppButton';
import type { ProxyNode } from '@/types';
import ProxyCoreStatusRail from './ProxyCoreStatusRail';
import ProxyNetworkIntegrationPanel from './ProxyNetworkIntegrationPanel';
import ProxyExportModal from './ProxyExportModal';
import ProxyImportModal from './ProxyImportModal';
import ProxyNodeCard from './ProxyNodeCard';
import ProxyNodeEditorModal from './ProxyNodeEditorModal';
import ProxyRoutingModal from './ProxyRoutingModal';
import ProxyShareModal from './ProxyShareModal';
import ProxySubscriptionsModal from './ProxySubscriptionsModal';
import { FUNCTIONAL_GROUP_OPTIONS, PROTOCOL_OPTIONS } from './proxy-pool-utils';
import { NEW_PROXY_NODE as NEW_NODE, useProxyPool } from './use-proxy-pool';

export default function ProxyPoolPanel() {
  const {
    loading,
    loadErrors,
    nodesData,
    subscriptions,
    routingResponse,
    setRoutingResponse,
    portsData,
    coreStatus,
    networkStatus,
    functionalGroup,
    setFunctionalGroup,
    countryFilter,
    setCountryFilter,
    protocolFilter,
    setProtocolFilter,
    pingingNodeId,
    batchPinging,
    coreAction,
    installPending,
    fetchData,
    activePortByNode,
    countryGroups,
    filteredNodes,
    dataPlaneReady,
    routing,
    runCoreAction,
    installCore,
    pingNode,
    pingAll,
    togglePort,
    deleteNode
  } = useProxyPool();

  const [editingNode, setEditingNode] = useState<Partial<ProxyNode> | null>(null);
  const [nodeEditorOpen, setNodeEditorOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [subscriptionsOpen, setSubscriptionsOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [routingOpen, setRoutingOpen] = useState(false);
  const [shareNode, setShareNode] = useState<ProxyNode | null>(null);

  return (
    <div className="proxy-pool-panel">
      <ProxyCoreStatusRail
        core={coreStatus}
        pendingAction={coreAction}
        onAction={(action) => void runCoreAction(action)}
        onInstall={() => void installCore()}
        installPending={installPending}
      />

      <ProxyNetworkIntegrationPanel status={networkStatus} core={coreStatus} onRefresh={fetchData} />

      {loadErrors.length > 0 && (
        <InlineNote
          className="toolkit-load-errors"
          tone="warning"
          description={loadErrors.join('；')}
          action={<Button size="small" onClick={() => void fetchData()}>重试</Button>}
        >
          部分状态读取失败
        </InlineNote>
      )}

      <div className="toolkit-stat-row">
        <StatisticCard.Group direction="row" bordered={false} className="hos-kpi-strip">
          <StatisticCard statistic={{
            title: '代理节点',
            value: nodesData?.total || 0,
            icon: <GlobalOutlined aria-hidden className="toolkit-kpi-icon" />
          }} />
          <StatisticCard statistic={{
            title: '订阅源（手动同步）',
            value: subscriptions.length,
            icon: <LinkOutlined aria-hidden className="toolkit-kpi-icon" />
          }} />
          <StatisticCard statistic={{
            title: '真实监听端口',
            value: `${activePortByNode.size} / ${portsData?.config.maxPorts || 32}`,
            valueStyle: { color: activePortByNode.size > 0 ? 'var(--color-success)' : 'var(--color-muted-strong)' },
            icon: <ForkOutlined aria-hidden className="toolkit-kpi-icon" />
          }} />
          <StatisticCard statistic={{
            title: '数据面',
            value: dataPlaneReady ? 'READY' : 'OFFLINE',
            valueStyle: { color: dataPlaneReady ? 'var(--color-success)' : 'var(--color-danger)' },
            icon: <SettingOutlined aria-hidden className="toolkit-kpi-icon" data-tone={dataPlaneReady ? 'ok' : 'err'} />
          }} />
        </StatisticCard.Group>
      </div>

      <div className="toolkit-category-bar proxy-pool-toolbar">
        <Space size={12} wrap>
          <Segmented
            aria-label="功能分组"
            value={functionalGroup}
            onChange={(value) => setFunctionalGroup(String(value))}
            options={FUNCTIONAL_GROUP_OPTIONS}
          />
          <Select
            aria-label="国家或地区筛选"
            allowClear
            value={countryFilter}
            placeholder="国家 / 地区"
            onChange={setCountryFilter}
            style={{ minWidth: 150 }}
            options={countryGroups.map((group) => ({
              label: `${group.icon || ''} ${group.name} (${group.count})`.trim(),
              value: group.id
            }))}
          />
          <Select
            aria-label="代理协议筛选"
            value={protocolFilter}
            onChange={setProtocolFilter}
            style={{ minWidth: 150 }}
            options={PROTOCOL_OPTIONS}
          />
        </Space>
        <Space size={8} wrap>
          <Tooltip title={dataPlaneReady ? '通过 Mihomo API 测量真实代理延迟' : '代理核心未就绪'}>
            <Button
              icon={<ThunderboltOutlined />}
              loading={batchPinging}
              disabled={!dataPlaneReady}
              onClick={() => void pingAll()}
            >
              批量实测
            </Button>
          </Tooltip>
          <Button icon={<ForkOutlined />} onClick={() => setRoutingOpen(true)}>分流与出口</Button>
          <Button icon={<ExportOutlined />} onClick={() => setExportOpen(true)}>配置导出</Button>
          <Button icon={<LinkOutlined />} onClick={() => setSubscriptionsOpen(true)}>
            订阅源 ({subscriptions.length})
          </Button>
          <Button icon={<ImportOutlined />} onClick={() => setImportOpen(true)}>导入</Button>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => {
              setEditingNode(NEW_NODE);
              setNodeEditorOpen(true);
            }}
          >
            添加节点
          </Button>
        </Space>
      </div>

      {(functionalGroup === 'ai' || functionalGroup === 'dev' || countryFilter) && (
        <InlineNote
          className="proxy-group-source"
          tone="info"
          description={functionalGroup === 'ai' || functionalGroup === 'dev'
            ? 'AI / 开发分组来自节点名称与标签的启发式分类，不代表订阅商原生线路能力。'
            : '国家分组优先使用节点显式地区字段；缺失时可能来自名称或服务器域名推断。'}
        >
          分组来源说明
        </InlineNote>
      )}

      {loading && !nodesData ? (
        <div className="toolkit-loading" role="status" aria-label="正在加载代理池"><Spin size="large" /></div>
      ) : filteredNodes.length === 0 ? (
        <InlineNote
          tone="info"
          description="可以导入订阅 URL、节点配置文本或二维码图片，也可以手动添加节点。"
          action={<Button type="primary" onClick={() => setImportOpen(true)}>立即导入</Button>}
        >
          当前筛选条件下没有节点
        </InlineNote>
      ) : (
        <div className="toolkit-grid proxy-node-grid">
          {filteredNodes.map((node) => (
            <ProxyNodeCard
              key={node.id}
              node={node}
              activePort={activePortByNode.get(node.id)}
              currentOutbound={routing?.activeOutboundNodeId === node.id}
              dataPlaneReady={dataPlaneReady}
              pinging={pingingNodeId === node.id}
              onPing={() => void pingNode(node.id)}
              onTogglePort={() => void togglePort(node)}
              onEdit={() => {
                setEditingNode(node);
                setNodeEditorOpen(true);
              }}
              onDelete={() => void deleteNode(node.id)}
              onShare={() => setShareNode(node)}
            />
          ))}
        </div>
      )}

      <ProxyNodeEditorModal
        open={nodeEditorOpen}
        node={editingNode}
        onClose={() => setNodeEditorOpen(false)}
        onSaved={fetchData}
      />
      <ProxyImportModal open={importOpen} onClose={() => setImportOpen(false)} onImported={fetchData} />
      <ProxyExportModal open={exportOpen} onClose={() => setExportOpen(false)} />
      <ProxySubscriptionsModal
        open={subscriptionsOpen}
        subscriptions={subscriptions}
        onClose={() => setSubscriptionsOpen(false)}
        onChanged={fetchData}
      />
      <ProxyRoutingModal
        open={routingOpen}
        dataPlaneReady={dataPlaneReady}
        nodes={nodesData?.nodes || []}
        routingResponse={routingResponse}
        onClose={() => setRoutingOpen(false)}
        onChanged={setRoutingResponse}
      />
      <ProxyShareModal open={Boolean(shareNode)} node={shareNode} onClose={() => setShareNode(null)} />
    </div>
  );
}
