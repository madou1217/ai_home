import { useState, useEffect } from 'react';
import { Card, Row, Col, Statistic, Table, Tag, Progress, Button, message } from 'antd';
import {
  TeamOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  SyncOutlined,
  ReloadOutlined
} from '@ant-design/icons';
import { accountsAPI, managementAPI } from '@/services/api';
import type { Account } from '@/types';
import ProviderIcon from '@/components/chat/ProviderIcon';
import dayjs from 'dayjs';

const Dashboard = () => {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(false);

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

  const handleReload = async () => {
    try {
      await managementAPI.reload();
      message.success('重新加载成功');
      loadAccounts();
    } catch (error) {
      message.error('重新加载失败');
    }
  };

  useEffect(() => {
    loadAccounts();
    const interval = setInterval(loadAccounts, 30000); // 每30秒刷新
    return () => clearInterval(interval);
  }, []);

  const totalAccounts = accounts.length;
  const configuredAccounts = accounts.filter(a => a.configured).length;
  const exhaustedAccounts = accounts.filter(a => a.exhausted).length;
  const healthyAccounts = accounts.filter(a => a.configured && !a.exhausted).length;

  const columns = [
    {
      title: '账号',
      dataIndex: 'displayName',
      key: 'displayName',
      render: (text: string, record: Account) => (
        <div>
          <div style={{ fontWeight: 'bold' }}>{text}</div>
          <div style={{ fontSize: '12px', color: '#999', display: 'flex', alignItems: 'center', gap: 4 }}>
            <ProviderIcon provider={record.provider} size={14} /> {record.accountId}
          </div>
        </div>
      )
    },
    {
      title: '类型',
      dataIndex: 'apiKeyMode',
      key: 'apiKeyMode',
      render: (apiKeyMode: boolean) => (
        <Tag color={apiKeyMode ? 'blue' : 'green'}>
          {apiKeyMode ? 'API Key' : 'OAuth'}
        </Tag>
      )
    },
    {
      title: '状态',
      dataIndex: 'exhausted',
      key: 'exhausted',
      render: (exhausted: boolean, record: Account) => {
        if (!record.configured) {
          return <Tag icon={<CloseCircleOutlined />} color="default">未配置</Tag>;
        }
        if (exhausted) {
          return <Tag icon={<CloseCircleOutlined />} color="error">已耗尽</Tag>;
        }
        return <Tag icon={<CheckCircleOutlined />} color="success">正常</Tag>;
      }
    },
    {
      title: '剩余额度',
      dataIndex: 'remainingPct',
      key: 'remainingPct',
      render: (pct: number, record: Account) => {
        if (!record.configured) return '-';
        const percent = Math.round(pct || 0);
        let status: 'success' | 'normal' | 'exception' = 'success';
        if (percent < 20) status = 'exception';
        else if (percent < 50) status = 'normal';
        return (
          <div style={{ width: 120 }}>
            <Progress percent={percent} size="small" status={status} />
          </div>
        );
      }
    },
    {
      title: '更新时间',
      dataIndex: 'updatedAt',
      key: 'updatedAt',
      render: (timestamp: number) => {
        if (!timestamp) return '-';
        return dayjs(timestamp).format('YYYY-MM-DD HH:mm:ss');
      }
    }
  ];

  return (
    <div>
      <div style={{ marginBottom: 24, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ margin: 0 }}>仪表盘</h1>
        <Button
          type="primary"
          icon={<ReloadOutlined />}
          onClick={handleReload}
        >
          重新加载账号
        </Button>
      </div>

      <Row gutter={16} style={{ marginBottom: 24 }}>
        <Col span={6}>
          <Card>
            <Statistic
              title="总账号数"
              value={totalAccounts}
              prefix={<TeamOutlined />}
              valueStyle={{ color: '#3f8600' }}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic
              title="已配置"
              value={configuredAccounts}
              prefix={<CheckCircleOutlined />}
              valueStyle={{ color: '#1890ff' }}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic
              title="健康账号"
              value={healthyAccounts}
              prefix={<CheckCircleOutlined />}
              valueStyle={{ color: '#52c41a' }}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic
              title="已耗尽"
              value={exhaustedAccounts}
              prefix={<CloseCircleOutlined />}
              valueStyle={{ color: '#cf1322' }}
            />
          </Card>
        </Col>
      </Row>

      <Card title="账号列表" extra={<SyncOutlined spin={loading} />}>
        <Table
          dataSource={accounts}
          columns={columns}
          rowKey={(record) => `${record.provider}-${record.accountId}`}
          loading={loading}
          pagination={{ pageSize: 10 }}
        />
      </Card>
    </div>
  );
};

export default Dashboard;
