import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Col, Form, Input, Modal, Row, Segmented, Space, Tag, Typography, message } from 'antd';
import { StatisticCard } from '@ant-design/pro-components';
import {
  CheckCircleOutlined,
  DeleteOutlined,
  LoginOutlined,
  ReloadOutlined,
  PlusOutlined
} from '@ant-design/icons';
import type { ProColumns } from '@ant-design/pro-components';
import {
  buildFabricBrokerProxyEndpoint,
  isControlPlaneManagementKeyConfigured,
  isControlPlaneProfileReady,
  listControlPlaneProfiles,
  normalizeControlPlaneEndpoint,
  refreshControlPlaneDeviceState,
  removeControlPlaneProfileSecure,
  resolveControlPlaneProfileEndpointInput,
  saveControlPlaneProfileSecure,
  syncSharedControlPlaneProfiles
} from '@/services/control-plane-profiles';
import {
  getActiveControlPlaneProfileId,
  resolveStoredActiveControlPlaneProfile,
  selectActiveControlPlaneProfile,
  selectActiveControlPlaneProfileSecure,
  syncStoredActiveControlPlaneProfile
} from '@/services/control-plane-selection';
import { getBrowserControlEndpoint } from '@/services/control-plane-endpoints';
import type { ControlPlaneProfile, ControlPlaneProfileConnectionMode } from '@/types';
import Button from '@/components/ui/AppButton';
import PageScaffold from '@/components/ui/PageScaffold';
import SectionCard from '@/components/ui/SectionCard';
import ListTable from '@/components/ui/ListTable';

type SaveFormValues = {
  endpoint?: string;
  connectionMode?: ControlPlaneProfileConnectionMode;
  brokerEndpoint?: string;
  brokerServerId?: string;
  name?: string;
  managementKey?: string;
};

type ConnectionFormValues = Pick<SaveFormValues, 'endpoint' | 'connectionMode' | 'brokerEndpoint' | 'brokerServerId'>;

const CONNECTION_MODE_OPTIONS = [
  { label: '直连 Server', value: 'direct' },
  { label: 'Broker Proxy', value: 'broker-proxy' }
];

function normalizeError(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  return String(error || '操作失败');
}

function normalizeConnectionMode(value: unknown): ControlPlaneProfileConnectionMode {
  return value === 'broker-proxy' ? 'broker-proxy' : 'direct';
}

function resolveProfileEndpoint(values: ConnectionFormValues) {
  return resolveControlPlaneProfileEndpointInput({
    endpoint: values.endpoint,
    connectionMode: normalizeConnectionMode(values.connectionMode),
    brokerEndpoint: values.brokerEndpoint,
    brokerServerId: values.brokerServerId
  });
}

function buildProxyPreview(brokerEndpoint?: string, brokerServerId?: string) {
  return buildFabricBrokerProxyEndpoint(brokerEndpoint || '', brokerServerId || '');
}

function getProfileStatus(profile: ControlPlaneProfile) {
  if (isControlPlaneProfileReady(profile)) return { color: 'green', label: 'ready' };
  if (profile.state === 'degraded') return { color: 'orange', label: 'degraded' };
  return { color: 'default', label: 'offline' };
}

function formatProfileDetail(profile: ControlPlaneProfile) {
  const chunks = [
    `${profile.schedulableAccountCount} 可调度账号`,
    `${profile.sessionCount} 会话`
  ];
  return chunks.join(' · ');
}

type ProfileRow = ControlPlaneProfile & { __key: string };

function getInitialServerSetupState() {
  const profiles = listControlPlaneProfiles();
  const active = resolveStoredActiveControlPlaneProfile(profiles, getActiveControlPlaneProfileId());
  return {
    profiles,
    activeProfileId: active.profileId
  };
}

export default function FabricServerSetup() {
  const navigate = useNavigate();
  const [saveForm] = Form.useForm<SaveFormValues>();
  const [initialState] = useState(getInitialServerSetupState);
  const [profiles, setProfiles] = useState<ControlPlaneProfile[]>(initialState.profiles);
  const [activeProfileId, setActiveProfileId] = useState(initialState.activeProfileId);
  const [checkingId, setCheckingId] = useState('');
  const [saving, setSaving] = useState(false);
  const [setupModalOpen, setSetupModalOpen] = useState(
    () => !initialState.profiles.some(isControlPlaneProfileReady)
  );

  const activeProfile = profiles.find((profile) => profile.id === activeProfileId) || null;
  const readyProfiles = profiles.filter(isControlPlaneProfileReady);
  const requiresInitialSetup = readyProfiles.length === 0;
  const defaultEndpoint = normalizeControlPlaneEndpoint(getBrowserControlEndpoint());
  const saveConnectionMode = normalizeConnectionMode(Form.useWatch('connectionMode', saveForm));
  const saveProxyPreview = buildProxyPreview(
    Form.useWatch('brokerEndpoint', saveForm),
    Form.useWatch('brokerServerId', saveForm)
  );

  const syncProfiles = (preferredProfileId = '') => {
    const nextProfiles = listControlPlaneProfiles();
    const resolution = preferredProfileId
      ? selectActiveControlPlaneProfile(nextProfiles, preferredProfileId)
      : syncStoredActiveControlPlaneProfile(nextProfiles);
    setProfiles(nextProfiles);
    setActiveProfileId(resolution.profileId);
    return resolution;
  };

  useEffect(() => {
    let cancelled = false;
    syncSharedControlPlaneProfiles()
      .then((result) => {
        if (cancelled) return;
        const nextProfiles = result.profiles.length > 0 ? result.profiles : listControlPlaneProfiles();
        const preferredProfileId = result.activeProfileId || activeProfileId;
        const resolution = preferredProfileId
          ? selectActiveControlPlaneProfile(nextProfiles, preferredProfileId)
          : syncStoredActiveControlPlaneProfile(nextProfiles);
        setProfiles(nextProfiles);
        setActiveProfileId(resolution.profileId);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    saveForm.setFieldsValue({
      connectionMode: 'direct',
      endpoint: defaultEndpoint,
      name: 'AIH Server'
    });
  }, [defaultEndpoint, saveForm]);

  const handleSaveServer = async (values: SaveFormValues) => {
    const completingInitialSetup = requiresInitialSetup;
    setSaving(true);
    try {
      const resolved = resolveProfileEndpoint(values);
      const managementKey = String(values.managementKey || '').trim();
      if (!managementKey) throw new Error('missing_management_key');
      const profile = await saveControlPlaneProfileSecure({
        endpoint: resolved.endpoint,
        connectionMode: resolved.connectionMode,
        broker: resolved.broker,
        name: values.name || resolved.endpoint,
        state: 'offline',
        managementKey,
        lastError: ''
      });
      try {
        await refreshControlPlaneDeviceState(profile);
      } catch (error) {
        await saveControlPlaneProfileSecure({
          name: profile.name,
          endpoint: profile.endpoint,
          descriptor: profile.descriptor,
          state: 'degraded',
          managementKey: profile.managementKey,
          credentialRef: profile.credentialRef,
          managementKeyConfigured: profile.managementKeyConfigured,
          lastError: normalizeError(error)
        });
        await selectActiveControlPlaneProfileSecure(listControlPlaneProfiles(), profile.id);
        syncProfiles();
        throw error;
      }
      await selectActiveControlPlaneProfileSecure(listControlPlaneProfiles(), profile.id);
      syncProfiles();
      saveForm.setFieldValue('managementKey', '');
      setSetupModalOpen(false);
      message.success('Server 已保存并设为当前');
      if (completingInitialSetup) navigate('/dashboard', { replace: true });
    } catch (error) {
      message.error(normalizeError(error));
    } finally {
      setSaving(false);
    }
  };

  const handleRefreshProfile = async (profile: ControlPlaneProfile) => {
    setCheckingId(profile.id);
    try {
      if (!isControlPlaneManagementKeyConfigured(profile)) throw new Error('missing_management_key');
      await refreshControlPlaneDeviceState(profile);
      message.success('Server 已同步');
      syncProfiles();
    } catch (error) {
      await saveControlPlaneProfileSecure({
        name: profile.name,
        endpoint: profile.endpoint,
        descriptor: profile.descriptor,
        state: isControlPlaneManagementKeyConfigured(profile) ? 'degraded' : 'offline',
        managementKey: profile.managementKey,
        credentialRef: profile.credentialRef,
        managementKeyConfigured: profile.managementKeyConfigured,
        lastError: normalizeError(error)
      });
      syncProfiles();
      message.error(normalizeError(error));
    } finally {
      setCheckingId('');
    }
  };

  const handleRemoveProfile = async (profileId: string) => {
    try {
      await removeControlPlaneProfileSecure(profileId);
      syncProfiles();
    } catch (error) {
      message.error(normalizeError(error));
    }
  };

  const handleSelectProfile = async (profileId: string) => {
    try {
      const resolution = await selectActiveControlPlaneProfileSecure(profiles, profileId);
      setActiveProfileId(resolution.profileId);
    } catch (error) {
      message.error(normalizeError(error));
    }
  };

  const profileRows: ProfileRow[] = useMemo(
    () => profiles.map((profile) => ({ ...profile, __key: profile.id })),
    [profiles]
  );

  const profileColumns: ProColumns<ProfileRow>[] = useMemo(() => [
    {
      title: 'Server',
      dataIndex: 'name',
      width: 240,
      ellipsis: true,
      render: (_, record) => (
        <Space direction="vertical" size={0} style={{ minWidth: 0 }}>
          <strong style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {record.name || record.endpoint}
          </strong>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{record.endpoint}</Typography.Text>
          {record.lastError && (
            <Typography.Text type="danger" style={{ fontSize: 12 }}>{record.lastError}</Typography.Text>
          )}
        </Space>
      )
    },
    {
      title: '状态 / 摘要',
      width: 320,
      render: (_, record) => {
        const status = getProfileStatus(record);
        const active = record.id === activeProfileId;
        return (
          <Space wrap size={[4, 4]}>
            {active && <Tag color="green">当前</Tag>}
            {record.connectionMode === 'broker-proxy' && <Tag color="blue">Broker</Tag>}
            {record.broker?.serverId && <Tag>{record.broker.serverId}</Tag>}
            <Tag color={status.color}>{status.label}</Tag>
            <Tag>{formatProfileDetail(record)}</Tag>
          </Space>
        );
      }
    },
    {
      title: '操作',
      width: 200,
      render: (_, record) => {
        const active = record.id === activeProfileId;
        return (
          <Space size={6} wrap>
            <Button size="small" disabled={active} onClick={() => handleSelectProfile(record.id)}>
              设为当前
            </Button>
            <Button
              size="small"
              icon={<ReloadOutlined />}
              loading={checkingId === record.id}
              onClick={() => handleRefreshProfile(record)}
            >
              同步
            </Button>
            <Button
              size="small"
              danger
              icon={<DeleteOutlined />}
              onClick={() => handleRemoveProfile(record.id)}
            >
              移除
            </Button>
          </Space>
        );
      }
    }
  ], [activeProfileId, checkingId]);

  return (
    <PageScaffold ghost
      title={requiresInitialSetup ? '连接 AIH Server' : '选择或添加 Server'}
      subTitle="使用 Server 网关地址和 Management Key 连接 AIH Server"
      extra={
        <Space size={8} wrap>
          <Button icon={<PlusOutlined />} onClick={() => setSetupModalOpen(true)}>
            添加 Server
          </Button>
          <Button
            type="primary"
            icon={<LoginOutlined />}
            disabled={!activeProfile || !isControlPlaneProfileReady(activeProfile)}
            onClick={() => navigate('/')}
          >
            进入工作台
          </Button>
        </Space>
      }
    >
      <StatisticCard.Group direction="row" style={{ marginBottom: 16 }}>
        <StatisticCard
          statistic={{
            title: '就绪 Server',
            value: readyProfiles.length,
            suffix: '个',
            status: readyProfiles.length > 0 ? 'success' : 'warning'
          }}
        />
        <StatisticCard
          statistic={{
            title: '已保存配置',
            value: profiles.length,
            suffix: '个'
          }}
        />
      </StatisticCard.Group>

      <SectionCard title="已保存 Server">
        <ListTable<ProfileRow>
          rowKey="__key"
          columns={profileColumns}
          dataSource={profileRows}
          loading={false}
        />
        <div style={{ marginTop: 24, paddingTop: 16, borderTop: '1px solid var(--app-border)', display: 'flex', gap: 16 }}>
          <Button type="link" onClick={() => navigate('/fabric/servers')} style={{ padding: 0 }}>
            打开高级 Server 设置
          </Button>
        </div>
      </SectionCard>

      <Modal
        title={requiresInitialSetup ? '连接 AIH Server' : '添加 Server'}
        open={setupModalOpen || requiresInitialSetup}
        width={760}
        footer={null}
        closable={!requiresInitialSetup}
        maskClosable={!requiresInitialSetup}
        keyboard={!requiresInitialSetup}
        destroyOnClose={false}
        forceRender
        onCancel={() => {
          if (!requiresInitialSetup) setSetupModalOpen(false);
        }}
      >
        {requiresInitialSetup && (
          <Typography.Paragraph type="secondary">
            首次使用需要连接一台 AIH Server。验证 Server 网关地址和 Management Key 后才能进入工作台。
          </Typography.Paragraph>
        )}
        <Form
          form={saveForm}
          layout="vertical"
          onFinish={handleSaveServer}
          initialValues={{
            connectionMode: 'direct',
            endpoint: defaultEndpoint,
            brokerEndpoint: '',
            brokerServerId: '',
            name: 'AIH Server',
            managementKey: ''
          }}
        >
          {!requiresInitialSetup && (
            <Form.Item name="connectionMode" label="连接模式">
              <Segmented block options={CONNECTION_MODE_OPTIONS} />
            </Form.Item>
          )}
          {!requiresInitialSetup && saveConnectionMode === 'broker-proxy' ? (
            <>
              <Row gutter={12}>
                <Col xs={24} sm={14}>
                  <Form.Item
                    name="brokerEndpoint"
                    label="Broker Endpoint"
                    help="远程 Broker 必须使用 HTTPS；HTTP 仅允许 127.0.0.1/localhost。"
                    rules={[{ required: true, message: '请输入 Broker Endpoint' }]}
                  >
                    <Input placeholder="https://broker.example.com" />
                  </Form.Item>
                </Col>
                <Col xs={24} sm={10}>
                  <Form.Item
                    name="brokerServerId"
                    label="Server ID"
                    rules={[{ required: true, message: '请输入 Server ID' }]}
                  >
                    <Input placeholder="aws-current" />
                  </Form.Item>
                </Col>
              </Row>
              <Form.Item label="Proxy Endpoint">
                <Input value={saveProxyPreview} readOnly placeholder="自动生成" />
              </Form.Item>
            </>
          ) : (
            <Form.Item
              name="endpoint"
              label="Server 网关地址"
              help="原生客户端要求远程 Server 使用 HTTPS；HTTP 仅允许 127.0.0.1/localhost。"
              rules={[{ required: true, message: '请输入 Server 网关地址' }]}
            >
              <Input placeholder="https://aih.example.com" />
            </Form.Item>
          )}
          <Form.Item name="name" label="显示名称">
            <Input placeholder="Home Fabric / Company Fabric" />
          </Form.Item>
          <Form.Item
            name="managementKey"
            label="Management Key"
            help="可通过 aih server config --show-secrets 查看。"
            rules={[{ required: true, message: '请输入 Management Key' }]}
          >
            <Input.Password autoComplete="new-password" placeholder="Management Key" />
          </Form.Item>
          <Button type="primary" htmlType="submit" icon={<CheckCircleOutlined />} loading={saving}>
            {requiresInitialSetup ? '连接并进入工作台' : '探测并保存'}
          </Button>
        </Form>
      </Modal>
    </PageScaffold>
  );
}
