import { useCallback, useEffect, useMemo, useState } from 'react';
import { Drawer, List, Popconfirm, Space, Tag, Tooltip, Typography } from 'antd';
import { CopyOutlined, DeleteOutlined, EditOutlined, LinkOutlined, PlusOutlined, ThunderboltOutlined } from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import { copyText } from '@/components/toolkit/proxy-pool/proxy-pool-utils';
import { aggregatorErrorText, chainIssue, describeChain, nameWithFlag, responseErrorCode, skipReasonText } from './aggregator-presentation';
import ManualNodeModal from './ManualNodeModal';
import NodeChainModal from './NodeChainModal';
import { parseManualContent, removeManualNode, serializeManualNodes, upsertManualNode, type ManualNode } from './manual-nodes';
import { subscriptionAggregatorAPI } from './subscription-aggregator-api';
import type { AggregatorLatency, AggregatorNodeOption, AggregatorProtocolForm, AggregatorSource, AggregatorSourceInput, AggregatorSourceNode } from './types';

const { Text } = Typography;

interface SourceNodesDrawerProps {
  source: AggregatorSource | null;
  forms: AggregatorProtocolForm[];
  width?: number | string;
  onClose: () => void;
  onSaveSource: (input: AggregatorSourceInput) => Promise<boolean>;
}

interface Row {
  key: string;
  /** 节点库里的 id（配前置节点用）；没对上节点库时为空串 */
  id: string;
  /** 连接身份（服务端下发）：延迟结果按它取，改名/重排都不漂 */
  nodeKey: string;
  name: string;
  protocol: string;
  server: string;
  port: number;
  flag: string;
  link: string;
  /** 链式代理的前置节点 id；空串表示直连 */
  chain: string;
  /** 手动节点在内容里的位置（可编辑）；其它来源为 -1 */
  index: number;
}

const addressKey = (server: string, port: number) => `${String(server).toLowerCase()}:${Number(port)}`;
// 本地展示用的地址键（协议|地址:端口）：只用于把表格行对上节点库，不是跨层引用键。
const rowAddressKey = (protocol: string, server: string, port: number) => `${protocol}|${addressKey(server, port)}`;

function latencyTag(latency: AggregatorLatency | undefined) {
  if (!latency) return null;
  if (latency.ms === null) return <Tag>{latency.error === 'ETIMEDOUT' ? '超时' : '连不上'}</Tag>;
  const color = latency.ms < 200 ? 'success' : latency.ms < 500 ? 'warning' : 'error';
  return <Tag color={color}>{latency.ms} ms</Tag>;
}

/**
 * 订阅源的节点：名称、协议、地址与从服务器测的 TCP 延迟，可复制分享链接。
 * 手动节点源（内容是本系统的中立 JSON）可以在这里新增、编辑、删除节点。
 * 每个节点还能配「前置节点」（链式代理），前置自己也能有前置，形成多级链。
 */
export default function SourceNodesDrawer({ source, forms, width = 720, onClose, onSaveSource }: SourceNodesDrawerProps) {
  const [nodes, setNodes] = useState<AggregatorSourceNode[]>([]);
  const [chainNodes, setChainNodes] = useState<AggregatorNodeOption[]>([]);
  const [latency, setLatency] = useState<Record<string, AggregatorLatency>>({});
  const [loading, setLoading] = useState(false);
  const [measuring, setMeasuring] = useState(false);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<{ index: number; node: ManualNode | null } | null>(null);
  const [chainEditing, setChainEditing] = useState<{ id: string; name: string } | null>(null);
  const manualNodes = useMemo(() => (source?.kind === 'local' ? parseManualContent(source.content) : null), [source]);

  const measure = useCallback(async (sourceId: string, fresh: boolean) => {
    setMeasuring(true);
    try {
      setLatency((await subscriptionAggregatorAPI.measureLatency(sourceId, fresh)).results);
    } catch (measureError) {
      setError(aggregatorErrorText(responseErrorCode(measureError), '测延迟失败'));
    } finally {
      setMeasuring(false);
    }
  }, []);

  // 链路要在整库节点上算（前置可能来自别的订阅源），所以单独拉一份全量节点。
  const reloadChainNodes = useCallback(async () => {
    try {
      setChainNodes((await subscriptionAggregatorAPI.nodes()).nodes);
    } catch (_chainError) {
      // 拿不到全量节点只是配不了前置，不影响这个抽屉的其它功能。
      setChainNodes([]);
    }
  }, []);

  useEffect(() => {
    if (!source) return;
    setError('');
    setLatency({});
    setLoading(true);
    subscriptionAggregatorAPI.sourceNodes(source.id)
      .then((result) => {
        setNodes(result.nodes);
        void measure(source.id, false);
      })
      .catch((loadError) => setError(aggregatorErrorText(responseErrorCode(loadError), '读取节点失败')))
      .finally(() => setLoading(false));
    void reloadChainNodes();
  }, [measure, reloadChainNodes, source]);

  // 延迟按节点 id 返回；手动节点行按地址对上同一个节点。
  // 延迟结果由服务端按连接身份（nodeKey）返回：用 id 会因改名/重排对不上（见 lib/runtime/node-identity.js）。
  const latencyByAddress = useMemo(() => new Map(nodes.map((node) => [addressKey(node.server, node.port), latency[node.nodeKey || node.id]])), [latency, nodes]);
  const linkByAddress = useMemo(() => new Map(nodes.map((node) => [rowAddressKey(node.protocol, node.server, node.port), node.link])), [nodes]);
  const idByAddress = useMemo(() => new Map(nodes.map((node) => [rowAddressKey(node.protocol, node.server, node.port), node.id])), [nodes]);
  const rows: Row[] = manualNodes
    ? manualNodes.map((node, index) => {
      const server = String(node.server || '');
      const port = Number(node.port);
      const key = rowAddressKey(node.protocol, server, port);
      return {
        key: `${index}`,
        id: idByAddress.get(key) || '',
        nodeKey: nodes.find((item) => rowAddressKey(item.protocol, item.server, item.port) === key)?.nodeKey || '',
        name: String(node.name || ''),
        protocol: node.protocol,
        server,
        port,
        flag: '',
        link: linkByAddress.get(key) || '',
        chain: chainNodes.find((item) => item.id === idByAddress.get(key))?.chain || '',
        index
      };
    })
    : nodes.map((node) => ({ ...node, key: node.id, index: -1 }));
  const fakeIp = Object.values(latency).some((item) => item?.fakeIp);

  const saveManual = async (next: ManualNode[]) => {
    if (!source) return false;
    const saved = await onSaveSource({ id: source.id, name: source.name, kind: 'local', content: serializeManualNodes(next) });
    // 重新读一遍：新节点要拿到节点库分配的 id 才能配前置，节点增删也可能改变链路。
    if (saved) {
      setNodes((await subscriptionAggregatorAPI.sourceNodes(source.id)).nodes);
      await reloadChainNodes();
    }
    return saved;
  };

  const saveChain = async (chain: string) => {
    if (!chainEditing) return false;
    // 成环、前置不存在这类错误由服务端判定，抛出去让弹窗显示原文案。
    await subscriptionAggregatorAPI.setNodeChain(chainEditing.id, chain);
    setNodes((current) => current.map((node) => (node.id === chainEditing.id ? { ...node, chain } : node)));
    await reloadChainNodes();
    return true;
  };

  const chainTag = (row: Row) => {
    if (!row.id || !row.chain) return null;
    const path = describeChain(row.id, chainNodes);
    const issue = chainIssue(row.id, chainNodes);
    const label = path ? `前置 ${path}` : '前置节点已不存在';
    const tag = <Tag color={issue ? 'warning' : 'blue'}>{label}</Tag>;
    return issue ? <Tooltip title={skipReasonText(issue)}>{tag}</Tooltip> : tag;
  };

  return (
    <Drawer
      title={source ? `节点 · ${source.name}` : '节点'}
      open={Boolean(source)}
      onClose={onClose}
      width={width}
      destroyOnHidden
      extra={(
        <Space>
          {manualNodes ? <Button icon={<PlusOutlined />} onClick={() => setEditing({ index: -1, node: null })}>添加节点</Button> : null}
          <Button icon={<ThunderboltOutlined />} loading={measuring} disabled={!source} onClick={() => source && void measure(source.id, true)}>测延迟</Button>
        </Space>
      )}
    >
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <Text type="secondary">延迟是从服务器到节点地址的 TCP 建连耗时，不经过节点，不代表代理一定可用。</Text>
        <Text type="secondary">前置节点（链式代理）：流量先经过前置，再由前置连到本节点；前置自己也能有前置，可以串成多级链。</Text>
        {fakeIp ? <Text type="warning">本机代理接管了 DNS（fake-ip），延迟是到本机代理的，不代表节点。</Text> : null}
        {error ? <Text type="danger">{error}</Text> : null}
        <List
          loading={loading}
          dataSource={rows}
          locale={{ emptyText: manualNodes ? '还没有节点，点右上角「添加节点」' : '这个订阅源没有节点' }}
          renderItem={(row) => (
            <List.Item
              actions={[
                row.link ? (
                  <Button key="copy" type="text" size="small" icon={<CopyOutlined />} aria-label={`复制 ${row.name} 的分享链接`} onClick={() => void copyText(row.link, '分享链接已复制')} />
                ) : null,
                row.id ? (
                  <Tooltip key="chain" title="配置前置节点（链式代理）">
                    <Button
                      type="text"
                      size="small"
                      icon={<LinkOutlined />}
                      aria-label={`配置 ${row.name} 的前置节点`}
                      onClick={() => setChainEditing({ id: row.id, name: row.name })}
                    />
                  </Tooltip>
                ) : null,
                row.index >= 0 && manualNodes ? (
                  <Button key="edit" type="text" size="small" icon={<EditOutlined />} aria-label={`编辑 ${row.name}`} onClick={() => setEditing({ index: row.index, node: manualNodes[row.index] })} />
                ) : null,
                row.index >= 0 && manualNodes ? (
                  <Popconfirm key="delete" title={`删除「${row.name}」？`} okText="删除" okButtonProps={{ danger: true }} onConfirm={() => void saveManual(removeManualNode(manualNodes, row.index))}>
                    <Button type="text" size="small" icon={<DeleteOutlined />} aria-label={`删除 ${row.name}`} />
                  </Popconfirm>
                ) : null
              ].filter(Boolean)}
            >
              <List.Item.Meta
                title={(
                  <Space size={6} wrap>
                    <span>{nameWithFlag(row.name, row.flag)}</span>
                    <Tag>{row.protocol}</Tag>
                    {latencyTag(latencyByAddress.get(addressKey(row.server, row.port)))}
                    {chainTag(row)}
                  </Space>
                )}
                description={`${row.server}:${row.port}`}
              />
            </List.Item>
          )}
        />
      </Space>
      <ManualNodeModal
        open={Boolean(editing)}
        title={editing?.node ? `编辑节点 · ${editing.node.name}` : '添加节点'}
        forms={forms}
        initial={editing?.node || null}
        width={width === '100%' ? '100%' : 720}
        onClose={() => setEditing(null)}
        onSubmit={async (node) => (manualNodes && editing ? saveManual(upsertManualNode(manualNodes, node, editing.index)) : false)}
      />
      <NodeChainModal
        open={Boolean(chainEditing)}
        node={chainEditing}
        nodes={chainNodes}
        onSubmit={saveChain}
        onClose={() => setChainEditing(null)}
      />
    </Drawer>
  );
}
