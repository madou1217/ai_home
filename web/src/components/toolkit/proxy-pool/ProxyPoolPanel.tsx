import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Space,
  Tag,
  Segmented,
  Tooltip,
  message,
  Modal,
  Form,
  Input,
  InputNumber,
  Select,
  Switch,
  Typography,
  Spin,
  Alert,
  Popconfirm,
  Badge,
  Upload,
  Divider,
  Radio
} from 'antd';
import {
  PlusOutlined,
  ImportOutlined,
  QrcodeOutlined,
  ThunderboltOutlined,
  ForkOutlined,
  ApiOutlined,
  DeleteOutlined,
  EditOutlined,
  SyncOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  LinkOutlined,
  CopyOutlined,
  GlobalOutlined,
  SettingOutlined,
  ShareAltOutlined,
  UploadOutlined,
  DownloadOutlined
} from '@ant-design/icons';
import { ProCard, StatisticCard } from '@ant-design/pro-components';
import Button from '@/components/ui/AppButton';
import { proxyPoolAPI } from '@/services/api';
import type {
  ProxyNode,
  ProxyNodesResponse,
  ProxySubscription,
  RoutingConfig,
  DedicatedPortsConfig,
  ProxyProtocol
} from '@/types';

const { Text, Title, Paragraph } = Typography;
const { Option } = Select;
const { TextArea } = Input;

export default function ProxyPoolPanel() {
  const [loading, setLoading] = useState<boolean>(false);
  const [nodesData, setNodesData] = useState<ProxyNodesResponse | null>(null);
  const [subsData, setSubsData] = useState<ProxySubscription[]>([]);
  const [routingData, setRoutingData] = useState<RoutingConfig | null>(null);
  const [dedicatedConfig, setDedicatedConfig] = useState<DedicatedPortsConfig | null>(null);

  // Filter
  const [groupFilter, setGroupFilter] = useState<string>('all');
  const [protocolFilter, setProtocolFilter] = useState<string>('all');

  // Action states
  const [pingingNodeId, setPingingNodeId] = useState<string | null>(null);
  const [batchPinging, setBatchPinging] = useState<boolean>(false);
  const [syncingSubId, setSyncingSubId] = useState<string | null>(null);

  // Modals
  const [editNodeModalVisible, setEditNodeModalVisible] = useState<boolean>(false);
  const [editingNode, setEditingNode] = useState<Partial<ProxyNode> | null>(null);

  const [importModalVisible, setImportModalVisible] = useState<boolean>(false);
  const [importContent, setImportContent] = useState<string>('');
  const [importing, setImporting] = useState<boolean>(false);

  const [subModalVisible, setSubModalVisible] = useState<boolean>(false);
  const [editingSub, setEditingSub] = useState<Partial<ProxySubscription> | null>(null);

  const [routingModalVisible, setRoutingModalVisible] = useState<boolean>(false);
  const [qrModalVisible, setQrModalVisible] = useState<boolean>(false);
  const [qrNode, setQrNode] = useState<ProxyNode | null>(null);

  const [form] = Form.useForm();
  const [subForm] = Form.useForm();

  // Load Data
  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [nodesRes, subsRes, routingRes, portsRes] = await Promise.all([
        proxyPoolAPI.listNodes(),
        proxyPoolAPI.listSubscriptions(),
        proxyPoolAPI.getRouting(),
        proxyPoolAPI.getDedicatedPorts()
      ]);

      if (nodesRes.ok) setNodesData(nodesRes);
      if (subsRes.ok) setSubsData(subsRes.subscriptions);
      if (routingRes.ok) setRoutingData(routingRes.routing);
      if (portsRes.ok) setDedicatedConfig(portsRes.config);
    } catch (e: any) {
      message.error(e.message || '加载代理池数据失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Filtered nodes
  const filteredNodes = useMemo(() => {
    if (!nodesData?.nodes) return [];
    let list = nodesData.nodes;

    if (groupFilter === 'dedicated') {
      list = list.filter((n) => Boolean(n.dedicatedPort));
    } else if (groupFilter === 'ai') {
      list = list.filter((n) => n.group === 'ai' || (n.tags && n.tags.includes('ai')) || ['US', 'JP', 'SG', 'GB', 'DE'].includes(n.countryCode || ''));
    } else if (groupFilter !== 'all') {
      list = list.filter((n) => n.countryCode === groupFilter || n.group === groupFilter);
    }

    if (protocolFilter !== 'all') {
      list = list.filter((n) => n.protocol === protocolFilter);
    }

    return list;
  }, [nodesData, groupFilter, protocolFilter]);

  // Ping single node
  const handlePingNode = async (nodeId: string) => {
    setPingingNodeId(nodeId);
    try {
      const res = await proxyPoolAPI.pingNode(nodeId);
      if (res.ok) {
        setNodesData((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            nodes: prev.nodes.map((n) => (n.id === nodeId ? { ...n, latencyMs: res.latencyMs } : n))
          };
        });
        if (res.reachable) {
          message.success(`节点延迟: ${res.latencyMs}ms`);
        } else {
          message.warning('节点连接超时或不可达');
        }
      }
    } catch (e: any) {
      message.error(e.message || '测速失败');
    } finally {
      setPingingNodeId(null);
    }
  };

  // Ping all nodes
  const handlePingAll = async () => {
    setBatchPinging(true);
    try {
      const res = await proxyPoolAPI.pingAllNodes({ group: groupFilter !== 'all' ? groupFilter : undefined });
      if (res.ok) {
        message.success(`已完成 ${res.testedCount} 个节点测速`);
        fetchData();
      }
    } catch (e: any) {
      message.error(e.message || '批量测速失败');
    } finally {
      setBatchPinging(false);
    }
  };

  // Toggle dedicated port
  const handleToggleDedicatedPort = async (node: ProxyNode) => {
    const isRunning = Boolean(node.dedicatedPort);
    try {
      const res = await proxyPoolAPI.toggleDedicatedPort(node.id, !isRunning);
      if (res.ok) {
        message.success(isRunning ? '已停止独立端口监听' : `已启动本地独立端口: 127.0.0.1:${res.port}`);
        fetchData();
      } else {
        message.error(res.error || '操作独立端口失败');
      }
    } catch (e: any) {
      message.error(e.message || '请求失败');
    }
  };

  // Delete node
  const handleDeleteNode = async (nodeId: string) => {
    try {
      const res = await proxyPoolAPI.deleteNode(nodeId);
      if (res.ok) {
        message.success('节点已删除');
        fetchData();
      }
    } catch (e: any) {
      message.error(e.message || '删除失败');
    }
  };

  // Save node
  const handleSaveNode = async () => {
    try {
      const values = await form.validateFields();
      const res = await proxyPoolAPI.upsertNode({
        ...editingNode,
        ...values
      });
      if (res.ok) {
        message.success('节点已保存');
        setEditNodeModalVisible(false);
        fetchData();
      }
    } catch (e: any) {
      message.error(e.message || '保存节点失败');
    }
  };

  // Import nodes
  const handleImport = async () => {
    if (!importContent.trim()) {
      message.warning('请输入订阅链接、Base64 或节点配置');
      return;
    }
    setImporting(true);
    try {
      const res = await proxyPoolAPI.importNodes(importContent);
      if (res.ok && res.count > 0) {
        message.success(`成功导入 ${res.count} 个节点`);
        setImportModalVisible(false);
        setImportContent('');
        fetchData();
      } else {
        message.error(res.error || '未识别到有效节点');
      }
    } catch (e: any) {
      message.error(e.message || '导入失败');
    } finally {
      setImporting(false);
    }
  };

  // Sync subscription
  const handleSyncSub = async (subId: string) => {
    setSyncingSubId(subId);
    try {
      const res = await proxyPoolAPI.syncSubscription(subId);
      if (res.ok) {
        message.success(`订阅已更新，同步到 ${res.count} 个节点`);
        fetchData();
      } else {
        message.error(res.error || '同步订阅失败');
      }
    } catch (e: any) {
      message.error(e.message || '同步失败');
    } finally {
      setSyncingSubId(null);
    }
  };

  // Delete subscription
  const handleDeleteSub = async (subId: string) => {
    try {
      const res = await proxyPoolAPI.deleteSubscription(subId);
      if (res.ok) {
        message.success('订阅及下属节点已清理');
        fetchData();
      }
    } catch (e: any) {
      message.error(e.message || '删除订阅失败');
    }
  };

  // Set Routing Mode
  const handleSetRoutingMode = async (mode: 'global' | 'rule' | 'direct', activeOutboundNodeId?: string) => {
    try {
      const res = await proxyPoolAPI.setRouting({ mode, activeOutboundNodeId });
      if (res.ok) {
        message.success(`分流模式已切换为: ${mode.toUpperCase()}`);
        setRoutingData(res.routing);
      }
    } catch (e: any) {
      message.error(e.message || '切换分流模式失败');
    }
  };

  // Helper render latency
  const renderLatencyBadge = (latency: number | null | undefined) => {
    if (latency === undefined || latency === null) return <Tag>未测速</Tag>;
    if (latency < 0) return <Tag color="error">超时/失败</Tag>;
    if (latency < 180) return <Tag color="success">{latency}ms 极速</Tag>;
    if (latency < 400) return <Tag color="warning">{latency}ms 良好</Tag>;
    return <Tag color="error">{latency}ms 较慢</Tag>;
  };

  const dedicatedPortCount = Object.keys(dedicatedConfig?.mappings || {}).length;

  return (
    <div className="proxy-pool-panel">
      {/* 顶部统计卡片 */}
      <div className="toolkit-stat-row">
        <StatisticCard.Group direction="row">
          <StatisticCard
            statistic={{
              title: '代理节点总数',
              value: nodesData?.total || 0,
              icon: <GlobalOutlined style={{ color: '#1677ff', fontSize: 24 }} />
            }}
          />
          <StatisticCard
            statistic={{
              title: '订阅源数量',
              value: subsData.length,
              icon: <LinkOutlined style={{ color: '#722ed1', fontSize: 24 }} />
            }}
          />
          <StatisticCard
            statistic={{
              title: '独立端口运行中',
              value: `${dedicatedPortCount} / ${dedicatedConfig?.maxPorts || 32}`,
              valueStyle: { color: dedicatedPortCount > 0 ? '#52c41a' : '#8c8c8c' },
              icon: <ForkOutlined style={{ color: '#52c41a', fontSize: 24 }} />
            }}
          />
          <StatisticCard
            statistic={{
              title: '当前分流模式',
              value: routingData?.mode?.toUpperCase() || 'RULE',
              valueStyle: { color: '#13c2c2', fontSize: 20 },
              icon: <SettingOutlined style={{ color: '#13c2c2', fontSize: 24 }} />
            }}
          />
        </StatisticCard.Group>
      </div>

      {/* 控制栏与快捷操作 */}
      <div className="toolkit-category-bar">
        <Space size={12} wrap>
          <Segmented
            value={groupFilter}
            onChange={(val) => setGroupFilter(val as string)}
            options={[
              { label: '全部 (ALL)', value: 'all' },
              { label: '🤖 AI 专线', value: 'ai' },
              { label: '🔌 独立端口', value: 'dedicated' },
              { label: '🇭🇰 香港', value: 'HK' },
              { label: '🇯🇵 日本', value: 'JP' },
              { label: '🇺🇸 美国', value: 'US' },
              { label: '🇸🇬 新加坡', value: 'SG' }
            ]}
          />

          <Select
            value={protocolFilter}
            onChange={setProtocolFilter}
            style={{ width: 140 }}
            options={[
              { label: '全部协议', value: 'all' },
              { label: 'Shadowsocks', value: 'shadowsocks' },
              { label: 'VMess', value: 'vmess' },
              { label: 'VLESS', value: 'vless' },
              { label: 'Trojan', value: 'trojan' },
              { label: 'Hysteria2', value: 'hysteria2' },
              { label: 'SOCKS5/HTTP', value: 'socks5' }
            ]}
          />
        </Space>

        <Space size={8} wrap>
          <Button
            icon={<ThunderboltOutlined />}
            loading={batchPinging}
            onClick={handlePingAll}
          >
            批量测速
          </Button>

          <Button
            icon={<ForkOutlined />}
            onClick={() => setRoutingModalVisible(true)}
          >
            分流规则
          </Button>

          <Button
            icon={<LinkOutlined />}
            onClick={() => setSubModalVisible(true)}
          >
            订阅管理 ({subsData.length})
          </Button>

          <Button
            icon={<ImportOutlined />}
            onClick={() => setImportModalVisible(true)}
          >
            导入订阅 / 二维码
          </Button>

          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => {
              setEditingNode({ protocol: 'shadowsocks', port: 8388, network: 'tcp' });
              form.resetFields();
              form.setFieldsValue({ protocol: 'shadowsocks', port: 8388, network: 'tcp' });
              setEditNodeModalVisible(true);
            }}
          >
            手动添加节点
          </Button>
        </Space>
      </div>

      {/* 节点列表网格 */}
      {loading && !nodesData ? (
        <div style={{ textAlign: 'center', padding: '60px 0' }}>
          <Spin size="large" />
        </div>
      ) : filteredNodes.length === 0 ? (
        <Alert
          type="info"
          showIcon
          message="当前分组暂无代理节点"
          description="您可以点击「手动添加节点」或「导入订阅 / 二维码」一键导入外部节点与订阅。"
          action={
            <Button type="primary" onClick={() => setImportModalVisible(true)}>
              立即导入
            </Button>
          }
        />
      ) : (
        <div className="toolkit-grid">
          {filteredNodes.map((node) => {
            const isDedicatedRunning = Boolean(node.dedicatedPort);
            const isPinging = pingingNodeId === node.id;
            const isCurrentOutbound = routingData?.activeOutboundNodeId === node.id;

            return (
              <div
                key={node.id}
                className={`toolkit-app-card ${isDedicatedRunning ? 'installed' : ''}`}
                style={{ borderColor: isCurrentOutbound ? '#1677ff' : undefined }}
              >
                <div>
                  <div className="toolkit-card-header">
                    <div className="toolkit-card-title-group">
                      <span style={{ fontSize: 24 }}>{node.countryFlag || '🌐'}</span>
                      <div>
                        <h3 className="toolkit-card-title" title={node.name}>
                          {node.name}
                        </h3>
                        <Space size={4} style={{ marginTop: 2 }}>
                          <Tag color="blue">{node.protocol.toUpperCase()}</Tag>
                          {renderLatencyBadge(node.latencyMs)}
                          {isCurrentOutbound && <Tag color="gold">当前出口</Tag>}
                        </Space>
                      </div>
                    </div>
                  </div>

                  <div className="toolkit-card-body">
                    <div className="toolkit-detail-row">
                      <span className="toolkit-detail-label">服务器地址:</span>
                      <span className="toolkit-detail-value">{node.server}:{node.port}</span>
                    </div>
                    {node.cipher && (
                      <div className="toolkit-detail-row">
                        <span className="toolkit-detail-label">加密方式:</span>
                        <span className="toolkit-detail-value">{node.cipher}</span>
                      </div>
                    )}
                    {node.sni && (
                      <div className="toolkit-detail-row">
                        <span className="toolkit-detail-label">SNI / 伪装:</span>
                        <span className="toolkit-detail-value">{node.sni}</span>
                      </div>
                    )}
                    {isDedicatedRunning && (
                      <div className="toolkit-detail-row">
                        <span className="toolkit-detail-label">本地独立端口:</span>
                        <Tag color="green" style={{ fontFamily: 'monospace' }}>
                          127.0.0.1:{node.dedicatedPort}
                        </Tag>
                      </div>
                    )}
                  </div>
                </div>

                <div className="toolkit-card-actions">
                  <Space size={6} wrap>
                    <Button
                      size="small"
                      loading={isPinging}
                      icon={<ThunderboltOutlined />}
                      onClick={() => handlePingNode(node.id)}
                    >
                      测速
                    </Button>

                    <Button
                      size="small"
                      type={isDedicatedRunning ? 'default' : 'dashed'}
                      icon={<ForkOutlined />}
                      onClick={() => handleToggleDedicatedPort(node)}
                    >
                      {isDedicatedRunning ? '关闭端口' : '独立端口'}
                    </Button>

                    <Button
                      size="small"
                      icon={<QrcodeOutlined />}
                      onClick={() => {
                        setQrNode(node);
                        setQrModalVisible(true);
                      }}
                    >
                      分享
                    </Button>
                  </Space>

                  <Space size={4}>
                    <Button
                      size="small"
                      icon={<EditOutlined />}
                      onClick={() => {
                        setEditingNode(node);
                        form.setFieldsValue(node);
                        setEditNodeModalVisible(true);
                      }}
                    />
                    <Popconfirm
                      title="确定删除此节点？"
                      onConfirm={() => handleDeleteNode(node.id)}
                      okText="删除"
                      cancelText="取消"
                    >
                      <Button size="small" danger icon={<DeleteOutlined />} />
                    </Popconfirm>
                  </Space>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* 手动添加/编辑节点弹窗 */}
      <Modal
        title={editingNode?.id ? '编辑代理节点' : '添加代理节点'}
        open={editNodeModalVisible}
        onOk={handleSaveNode}
        onCancel={() => setEditNodeModalVisible(false)}
        width={560}
      >
        <Form form={form} layout="vertical" initialValues={editingNode || {}}>
          <Form.Item label="节点名称" name="name" rules={[{ required: true, message: '请输入节点名称' }]}>
            <Input placeholder="香港-BGP专线 01" />
          </Form.Item>

          <Form.Item label="协议类型" name="protocol" rules={[{ required: true }]}>
            <Select>
              <Option value="shadowsocks">Shadowsocks (SS)</Option>
              <Option value="vmess">VMess</Option>
              <Option value="vless">VLESS</Option>
              <Option value="trojan">Trojan</Option>
              <Option value="hysteria2">Hysteria 2 (HY2)</Option>
              <Option value="socks5">SOCKS5</Option>
              <Option value="http">HTTP / HTTPS</Option>
            </Select>
          </Form.Item>

          <Space style={{ display: 'flex', width: '100%' }} size={12}>
            <Form.Item label="服务器地址" name="server" rules={[{ required: true, message: '请输入服务器IP或域名' }]} style={{ flex: 1 }}>
              <Input placeholder="hk.node.com 或 1.2.3.4" />
            </Form.Item>
            <Form.Item label="端口" name="port" rules={[{ required: true, message: '请输入端口' }]} style={{ width: 140 }}>
              <InputNumber min={1} max={65535} style={{ width: '100%' }} />
            </Form.Item>
          </Space>

          <Form.Item label="密码 / 密钥 / UUID" name="password">
            <Input.Password placeholder="密码或 UUID" />
          </Form.Item>

          <Space style={{ display: 'flex', width: '100%' }} size={12}>
            <Form.Item label="加密方式 (Cipher)" name="cipher" style={{ flex: 1 }}>
              <Input placeholder="aes-256-gcm / auto / chacha20-ietf-poly1305" />
            </Form.Item>
            <Form.Item label="传输网络 (Network)" name="network" style={{ flex: 1 }}>
              <Select defaultValue="tcp">
                <Option value="tcp">TCP</Option>
                <Option value="ws">WebSocket</Option>
                <Option value="grpc">gRPC</Option>
                <Option value="h2">HTTP/2</Option>
              </Select>
            </Form.Item>
          </Space>

          <Space style={{ display: 'flex', width: '100%' }} size={12}>
            <Form.Item label="SNI / 伪装域名" name="sni" style={{ flex: 1 }}>
              <Input placeholder="apple.com 或 cloudflare.com" />
            </Form.Item>
            <Form.Item label="路径 (Path)" name="path" style={{ flex: 1 }}>
              <Input placeholder="/ws 或 /graphql" />
            </Form.Item>
          </Space>
        </Form>
      </Modal>

      {/* 导入订阅/二维码弹窗 */}
      <Modal
        title="导入订阅链接 / 节点文本 / 二维码"
        open={importModalVisible}
        onOk={handleImport}
        confirmLoading={importing}
        onCancel={() => setImportModalVisible(false)}
        width={580}
      >
        <div style={{ marginBottom: 16 }}>
          <Paragraph type="secondary">
            支持 <code>ss://</code>, <code>vmess://</code>, <code>vless://</code>, <code>trojan://</code>, <code>hy2://</code> 单节点链接；支持 Base64 订阅文本、Clash YAML、Sing-box JSON 配置。
          </Paragraph>
          <TextArea
            rows={8}
            placeholder="粘贴订阅链接、Clash YAML、或 ss://, vmess:// 节点分享链接（每行一个）"
            value={importContent}
            onChange={(e) => setImportContent(e.target.value)}
          />
        </div>
      </Modal>

      {/* 订阅管理弹窗 */}
      <Modal
        title="订阅源管理"
        open={subModalVisible}
        onCancel={() => setSubModalVisible(false)}
        footer={null}
        width={620}
      >
        <div style={{ marginBottom: 16 }}>
          <Form
            form={subForm}
            layout="inline"
            onFinish={async (values) => {
              const res = await proxyPoolAPI.upsertSubscription(values);
              if (res.ok) {
                message.success('订阅已添加');
                subForm.resetFields();
                fetchData();
              }
            }}
          >
            <Form.Item name="name" rules={[{ required: true, message: '订阅名称' }]}>
              <Input placeholder="订阅名称 (如: 机场A)" style={{ width: 140 }} />
            </Form.Item>
            <Form.Item name="url" rules={[{ required: true, message: '订阅链接' }]} style={{ flex: 1 }}>
              <Input placeholder="https://domain.com/api/v1/client/subscribe?token=..." />
            </Form.Item>
            <Form.Item>
              <Button type="primary" htmlType="submit">添加</Button>
            </Form.Item>
          </Form>
        </div>

        <Divider />

        <div style={{ maxHeight: 360, overflowY: 'auto' }}>
          {subsData.map((sub) => (
            <div key={sub.id} className="toolkit-mirror-row">
              <div>
                <strong>{sub.name}</strong>
                <Tag color="blue" style={{ marginLeft: 8 }}>{sub.nodeCount} 个节点</Tag>
                <div style={{ marginTop: 4 }}>
                  <Text type="secondary" code style={{ fontSize: 11 }}>{sub.url}</Text>
                </div>
              </div>

              <Space>
                <Button
                  size="small"
                  icon={<SyncOutlined />}
                  loading={syncingSubId === sub.id}
                  onClick={() => handleSyncSub(sub.id)}
                >
                  刷新节点
                </Button>
                <Popconfirm
                  title="删除该订阅及所属节点？"
                  onConfirm={() => handleDeleteSub(sub.id)}
                >
                  <Button size="small" danger icon={<DeleteOutlined />} />
                </Popconfirm>
              </Space>
            </div>
          ))}
        </div>
      </Modal>

      {/* 分流规则弹窗 */}
      <Modal
        title="智能规则分流与出口设置"
        open={routingModalVisible}
        onCancel={() => setRoutingModalVisible(false)}
        footer={null}
        width={680}
      >
        <div style={{ marginBottom: 20 }}>
          <Title level={5}>出站分流模式</Title>
          <Radio.Group
            value={routingData?.mode || 'rule'}
            onChange={(e) => handleSetRoutingMode(e.target.value)}
          >
            <Radio.Button value="rule">智能规则分流 (Rule)</Radio.Button>
            <Radio.Button value="global">全局代理模式 (Global)</Radio.Button>
            <Radio.Button value="direct">全局直连模式 (Direct)</Radio.Button>
          </Radio.Group>
        </div>

        <div style={{ marginBottom: 20 }}>
          <Title level={5}>默认出站代理节点</Title>
          <Select
            style={{ width: '100%' }}
            value={routingData?.activeOutboundNodeId || undefined}
            placeholder="选择全局或规则代理的默认出站节点"
            onChange={(val) => handleSetRoutingMode(routingData?.mode || 'rule', val)}
            options={nodesData?.nodes.map((n) => ({
              label: `${n.countryFlag || '🌐'} ${n.name} (${n.server}:${n.port})`,
              value: n.id
            }))}
          />
        </div>

        <Title level={5}>内置分流策略规则</Title>
        <Space orientation="vertical" style={{ width: '100%' }}>
          {routingData?.rules.map((r) => (
            <div key={r.id} className="toolkit-mirror-row">
              <div>
                <strong>{r.name}</strong>
                <Tag color={r.outbound === 'proxy' ? 'blue' : 'green'} style={{ marginLeft: 8 }}>
                  {r.outbound === 'proxy' ? '走代理节点' : '国内直连'}
                </Tag>
                <div style={{ marginTop: 4 }}>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    匹配域名: {r.domains?.slice(0, 4).join(', ')} ...
                  </Text>
                </div>
              </div>
            </div>
          ))}
        </Space>
      </Modal>

      {/* 二维码与链接导出弹窗 */}
      <Modal
        title="节点分享链接 / 二维码"
        open={qrModalVisible}
        onCancel={() => setQrModalVisible(false)}
        footer={null}
      >
        {qrNode && (
          <div style={{ textAlign: 'center', padding: '16px 0' }}>
            <Title level={4}>{qrNode.countryFlag} {qrNode.name}</Title>
            <div style={{ background: '#f5f5f5', padding: 12, borderRadius: 8, margin: '16px 0', wordBreak: 'break-all', fontFamily: 'monospace', fontSize: 12 }}>
              {qrNode.rawUri || `${qrNode.protocol}://${qrNode.server}:${qrNode.port}`}
            </div>
            <Button
              type="primary"
              icon={<CopyOutlined />}
              onClick={() => {
                const text = qrNode.rawUri || `${qrNode.protocol}://${qrNode.server}:${qrNode.port}`;
                navigator.clipboard.writeText(text);
                message.success('已复制到剪贴板');
              }}
            >
              复制分享链接
            </Button>
          </div>
        )}
      </Modal>
    </div>
  );
}
