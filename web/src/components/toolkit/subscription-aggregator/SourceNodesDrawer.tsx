import { useCallback, useEffect, useMemo, useState } from 'react';
import { Drawer, List, Popconfirm, Space, Tag, Typography } from 'antd';
import { CopyOutlined, DeleteOutlined, EditOutlined, PlusOutlined, ThunderboltOutlined } from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import { copyText } from '@/components/toolkit/proxy-pool/proxy-pool-utils';
import { aggregatorErrorText, nameWithFlag, responseErrorCode } from './aggregator-presentation';
import ManualNodeModal from './ManualNodeModal';
import { parseManualContent, removeManualNode, serializeManualNodes, upsertManualNode, type ManualNode } from './manual-nodes';
import { subscriptionAggregatorAPI } from './subscription-aggregator-api';
import type { AggregatorLatency, AggregatorProtocolForm, AggregatorSource, AggregatorSourceInput, AggregatorSourceNode } from './types';

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
  name: string;
  protocol: string;
  server: string;
  port: number;
  flag: string;
  link: string;
  /** 手动节点在内容里的位置（可编辑）；其它来源为 -1 */
  index: number;
}

const addressKey = (server: string, port: number) => `${String(server).toLowerCase()}:${Number(port)}`;

function latencyTag(latency: AggregatorLatency | undefined) {
  if (!latency) return null;
  if (latency.ms === null) return <Tag>{latency.error === 'ETIMEDOUT' ? '超时' : '连不上'}</Tag>;
  const color = latency.ms < 200 ? 'success' : latency.ms < 500 ? 'warning' : 'error';
  return <Tag color={color}>{latency.ms} ms</Tag>;
}

/**
 * 订阅源的节点：名称、协议、地址与从服务器测的 TCP 延迟，可复制分享链接。
 * 手动节点源（内容是本系统的中立 JSON）可以在这里新增、编辑、删除节点。
 */
export default function SourceNodesDrawer({ source, forms, width = 720, onClose, onSaveSource }: SourceNodesDrawerProps) {
  const [nodes, setNodes] = useState<AggregatorSourceNode[]>([]);
  const [latency, setLatency] = useState<Record<string, AggregatorLatency>>({});
  const [loading, setLoading] = useState(false);
  const [measuring, setMeasuring] = useState(false);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<{ index: number; node: ManualNode | null } | null>(null);
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
  }, [measure, source]);

  // 延迟按节点 id 返回；手动节点行按地址对上同一个节点。
  const latencyByAddress = useMemo(() => new Map(nodes.map((node) => [addressKey(node.server, node.port), latency[node.id]])), [latency, nodes]);
  const linkByAddress = useMemo(() => new Map(nodes.map((node) => [`${node.protocol}|${addressKey(node.server, node.port)}`, node.link])), [nodes]);
  const rows: Row[] = manualNodes
    ? manualNodes.map((node, index) => ({
      key: `${index}`,
      name: String(node.name || ''),
      protocol: node.protocol,
      server: String(node.server || ''),
      port: Number(node.port),
      flag: '',
      link: linkByAddress.get(`${node.protocol}|${addressKey(String(node.server || ''), Number(node.port))}`) || '',
      index
    }))
    : nodes.map((node) => ({ ...node, key: node.id, index: -1 }));
  const fakeIp = Object.values(latency).some((item) => item?.fakeIp);

  const saveManual = async (next: ManualNode[]) => {
    if (!source) return false;
    return onSaveSource({ id: source.id, name: source.name, kind: 'local', content: serializeManualNodes(next) });
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
    </Drawer>
  );
}
