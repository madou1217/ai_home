import { useState, useEffect, useMemo } from 'react';
import {
  Table,
  Button,
  Space,
  Tag,
  Modal,
  Form,
  Input,
  Select,
  message,
  Progress,
  Card,
  Tabs,
  Statistic,
  Row,
  Col,
  Dropdown
} from 'antd';
import type { MenuProps } from 'antd';
import {
  PlusOutlined,
  DeleteOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  ReloadOutlined,
  FilterOutlined,
  MoreOutlined,
  SyncOutlined
} from '@ant-design/icons';
import { accountsAPI, managementAPI } from '@/services/api';
import type { Account } from '@/types';
import ProviderIcon from '@/components/chat/ProviderIcon';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import 'dayjs/locale/zh-cn';

dayjs.extend(relativeTime);
dayjs.locale('zh-cn');

const Accounts = () => {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [form] = Form.useForm();
  const [activeProvider, setActiveProvider] = useState<string>('all');
  const [filterStatus, setFilterStatus] = useState<string>('all');

  const loadAccounts = async () => {
    setLoading(true);
    try {
      const data = await accountsAPI.list();
      setAccounts(data);
    } catch (error) {
      message.error('加载账号失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAccounts();
    const interval = setInterval(loadAccounts, 30000);
    return () => clearInterval(interval);
  }, []);

  const handleAdd = async (values: any) => {
    try {
      const config = values.apiKey ? {
        apiKey: values.apiKey,
        baseUrl: values.baseUrl
      } : undefined;

      await accountsAPI.add(values.provider, values.accountId, config);
      message.success('添加账号成功');
      setModalVisible(false);
      form.resetFields();
      loadAccounts();
    } catch (error: any) {
      message.error(error?.response?.data?.message || '添加账号失败');
    }
  };

  const handleDelete = async (provider: string, accountId: string) => {
    try {
      await accountsAPI.delete(provider, accountId);
      message.success('删除账号成功');
      loadAccounts();
    } catch (error) {
      message.error('删除账号失败');
    }
  };

  const handleReload = async () => {
    try {
      await managementAPI.reload();
      message.success('重新加载成功');
      loadAccounts();
    } catch (error) {
      message.error('重新加载失败');
    }
  };

  // 按 Provider 分组统计
  const providerStats = useMemo(() => {
    const stats: Record<string, { total: number; healthy: number; exhausted: number }> = {
      all: { total: 0, healthy: 0, exhausted: 0 },
      codex: { total: 0, healthy: 0, exhausted: 0 },
      gemini: { total: 0, healthy: 0, exhausted: 0 },
      claude: { total: 0, healthy: 0, exhausted: 0 }
    };

    accounts.forEach(account => {
      const provider = account.provider;
      stats.all.total++;
      stats[provider].total++;

      if (account.configured && !account.exhausted) {
        stats.all.healthy++;
        stats[provider].healthy++;
      }

      if (account.exhausted) {
        stats.all.exhausted++;
        stats[provider].exhausted++;
      }
    });

    return stats;
  }, [accounts]);

  // 过滤账号
  const filteredAccounts = useMemo(() => {
    let filtered = accounts;

    // 按 provider 过滤
    if (activeProvider !== 'all') {
      filtered = filtered.filter(a => a.provider === activeProvider);
    }

    // 按状态过滤
    if (filterStatus === 'healthy') {
      filtered = filtered.filter(a => a.configured && !a.exhausted);
    } else if (filterStatus === 'exhausted') {
      filtered = filtered.filter(a => a.exhausted);
    } else if (filterStatus === 'unconfigured') {
      filtered = filtered.filter(a => !a.configured);
    }

    return filtered;
  }, [accounts, activeProvider, filterStatus]);

  const columns = [
    {
      title: '账号',
      dataIndex: 'displayName',
      key: 'displayName',
      width: 250,
      render: (text: string, record: Account) => (
        <div>
          <div style={{ fontWeight: 'bold', marginBottom: 4 }}>{text}</div>
          <Space size="small" align="center">
            <ProviderIcon provider={record.provider} size={16} />
            <span style={{ fontSize: '12px', color: '#999' }}>
              ID: {record.accountId}
            </span>
          </Space>
        </div>
      )
    },
    {
      title: '认证类型',
      dataIndex: 'apiKeyMode',
      key: 'apiKeyMode',
      width: 100,
      render: (apiKeyMode: boolean) => (
        <Tag color={apiKeyMode ? 'blue' : 'green'}>
          {apiKeyMode ? 'API Key' : 'OAuth'}
        </Tag>
      )
    },
    {
      title: '配置状态',
      dataIndex: 'configured',
      key: 'configured',
      width: 100,
      render: (configured: boolean) => (
        <Tag
          icon={configured ? <CheckCircleOutlined /> : <CloseCircleOutlined />}
          color={configured ? 'success' : 'default'}
        >
          {configured ? '已配置' : '未配置'}
        </Tag>
      )
    },
    {
      title: '运行状态',
      dataIndex: 'exhausted',
      key: 'exhausted',
      width: 100,
      render: (exhausted: boolean, record: Account) => {
        if (!record.configured) return <Tag color="default">未配置</Tag>;
        return (
          <Tag
            icon={exhausted ? <CloseCircleOutlined /> : <CheckCircleOutlined />}
            color={exhausted ? 'error' : 'success'}
          >
            {exhausted ? '已耗尽' : '正常'}
          </Tag>
        );
      }
    },
    {
      title: '剩余额度',
      dataIndex: 'remainingPct',
      key: 'remainingPct',
      width: 180,
      sorter: (a: Account, b: Account) => (a.remainingPct || 0) - (b.remainingPct || 0),
      render: (pct: number, record: Account) => {
        if (!record.configured) return '-';
        const percent = Math.round(pct || 0);
        let status: 'success' | 'normal' | 'exception' = 'success';
        if (percent < 20) status = 'exception';
        else if (percent < 50) status = 'normal';
        return (
          <div style={{ width: 150 }}>
            <Progress
              percent={percent}
              size="small"
              status={status}
              format={(p) => `${p}%`}
            />
          </div>
        );
      }
    },
    {
      title: '更新时间',
      dataIndex: 'updatedAt',
      key: 'updatedAt',
      width: 150,
      sorter: (a: Account, b: Account) => (a.updatedAt || 0) - (b.updatedAt || 0),
      render: (timestamp: number) => {
        if (!timestamp) return '-';
        return (
          <div>
            <div>{dayjs(timestamp).format('MM-DD HH:mm')}</div>
            <div style={{ fontSize: '12px', color: '#999' }}>
              {dayjs(timestamp).fromNow()}
            </div>
          </div>
        );
      }
    },
    {
      title: '操作',
      key: 'actions',
      width: 120,
      fixed: 'right' as const,
      render: (_: any, record: Account) => {
        const menuItems: MenuProps['items'] = [
          {
            key: 'delete',
            label: '删除账号',
            danger: true,
            icon: <DeleteOutlined />
          }
        ];

        return (
          <Space>
            <Dropdown
              menu={{
                items: menuItems,
                onClick: ({ key }) => {
                  if (key === 'delete') {
                    Modal.confirm({
                      title: '确认删除？',
                      content: `删除后账号 ${record.displayName} 的所有数据都将被清除`,
                      okText: '确认',
                      cancelText: '取消',
                      okButtonProps: { danger: true },
                      onOk: () => handleDelete(record.provider, record.accountId)
                    });
                  }
                }
              }}
              trigger={['click']}
            >
              <Button icon={<MoreOutlined />} />
            </Dropdown>
          </Space>
        );
      }
    }
  ];

  const tabItems = [
    {
      key: 'all',
      label: <span style={{ padding: '0 8px' }}>全部 ({providerStats.all.total})</span>
    },
    {
      key: 'codex',
      label: (
        <span style={{ padding: '0 8px', display: 'flex', alignItems: 'center', gap: 4 }}>
          <ProviderIcon provider="codex" size={14} /> ChatGPT ({providerStats.codex.total})
        </span>
      )
    },
    {
      key: 'gemini',
      label: (
        <span style={{ padding: '0 8px', display: 'flex', alignItems: 'center', gap: 4 }}>
          <ProviderIcon provider="gemini" size={14} /> Gemini ({providerStats.gemini.total})
        </span>
      )
    },
    {
      key: 'claude',
      label: (
        <span style={{ padding: '0 8px', display: 'flex', alignItems: 'center', gap: 4 }}>
          <ProviderIcon provider="claude" size={14} /> Claude ({providerStats.claude.total})
        </span>
      )
    }
  ];

  return (
    <div>
      <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ margin: 0 }}>账号管理</h1>
        <Space>
          <Button
            icon={<ReloadOutlined />}
            onClick={loadAccounts}
            loading={loading}
          >
            刷新
          </Button>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => setModalVisible(true)}
          >
            添加账号
          </Button>
        </Space>
      </div>

      {/* 统计卡片 */}
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={6}>
          <Card>
            <Statistic
              title="总账号数"
              value={providerStats[activeProvider].total}
              prefix={<CheckCircleOutlined />}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic
              title="健康账号"
              value={providerStats[activeProvider].healthy}
              valueStyle={{ color: '#3f8600' }}
              prefix={<CheckCircleOutlined />}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic
              title="已耗尽"
              value={providerStats[activeProvider].exhausted}
              valueStyle={{ color: '#cf1322' }}
              prefix={<CloseCircleOutlined />}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic
              title="可用率"
              value={providerStats[activeProvider].total > 0
                ? Math.round((providerStats[activeProvider].healthy / providerStats[activeProvider].total) * 100)
                : 0
              }
              suffix="%"
              valueStyle={{
                color: providerStats[activeProvider].total > 0 &&
                  (providerStats[activeProvider].healthy / providerStats[activeProvider].total) > 0.5
                  ? '#3f8600' : '#cf1322'
              }}
            />
          </Card>
        </Col>
      </Row>

      <Card>
        <Tabs
          activeKey={activeProvider}
          onChange={setActiveProvider}
          items={tabItems}
          tabBarExtraContent={
            <Space>
              <Select
                value={filterStatus}
                onChange={setFilterStatus}
                style={{ width: 120 }}
                options={[
                  { label: '全部状态', value: 'all' },
                  { label: '健康', value: 'healthy' },
                  { label: '已耗尽', value: 'exhausted' },
                  { label: '未配置', value: 'unconfigured' }
                ]}
                suffixIcon={<FilterOutlined />}
              />
              <Button
                icon={<SyncOutlined />}
                onClick={handleReload}
              >
                重新加载
              </Button>
            </Space>
          }
        />

        <Table
          dataSource={filteredAccounts}
          columns={columns}
          rowKey={(record) => `${record.provider}-${record.accountId}`}
          loading={loading}
          pagination={{
            pageSize: 20,
            showTotal: (total) => `共 ${total} 个账号`,
            showSizeChanger: true,
            showQuickJumper: true
          }}
          scroll={{ x: 1200 }}
        />
      </Card>

      <Modal
        title="添加新账号"
        open={modalVisible}
        onOk={() => form.submit()}
        onCancel={() => {
          setModalVisible(false);
          form.resetFields();
        }}
        okText="确定"
        cancelText="取消"
        width={600}
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={handleAdd}
        >
          <Form.Item
            name="provider"
            label="Provider"
            rules={[{ required: true, message: '请选择 Provider' }]}
          >
            <Select placeholder="选择 Provider" size="large">
              <Select.Option value="codex">
                <Space align="center">
                  <ProviderIcon provider="codex" size={18} />
                  <span>ChatGPT (OpenAI)</span>
                </Space>
              </Select.Option>
              <Select.Option value="gemini">
                <Space align="center">
                  <ProviderIcon provider="gemini" size={18} />
                  <span>Gemini (Google)</span>
                </Space>
              </Select.Option>
              <Select.Option value="claude">
                <Space align="center">
                  <ProviderIcon provider="claude" size={18} />
                  <span>Claude (Anthropic)</span>
                </Space>
              </Select.Option>
            </Select>
          </Form.Item>

          <Form.Item
            name="accountId"
            label="账号 ID"
            rules={[
              { required: true, message: '请输入账号 ID' },
              { pattern: /^\d+$/, message: '账号 ID 必须是数字' }
            ]}
          >
            <Input placeholder="例如: 1, 2, 3..." size="large" />
          </Form.Item>

          <Form.Item
            name="apiKey"
            label="API Key (可选)"
            help="如果使用 OAuth 登录，请留空此字段"
          >
            <Input.Password placeholder="留空表示使用 OAuth 登录" size="large" />
          </Form.Item>

          <Form.Item
            name="baseUrl"
            label="Base URL (可选)"
            help="仅在使用 API Key 时需要填写"
          >
            <Input placeholder="https://api.example.com" size="large" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default Accounts;
