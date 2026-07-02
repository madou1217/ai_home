import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Col, Form, Input, Modal, Row, Segmented, Space, Tabs, Tag, Typography, message } from 'antd';
import { StatisticCard } from '@ant-design/pro-components';
import {
  CheckCircleOutlined,
  DeleteOutlined,
  LinkOutlined,
  LoginOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  PlusOutlined
} from '@ant-design/icons';
import type { ProColumns } from '@ant-design/pro-components';
import {
  buildFabricBrokerProxyEndpoint,
  fetchControlPlaneDescriptor,
  isControlPlaneProfileReady,
  listControlPlaneProfiles,
  normalizeControlPlaneEndpoint,
  pairControlPlaneDevice,
  parseControlPlanePairIntentFromSearch,
  refreshControlPlaneDeviceState,
  removeControlPlaneProfile,
  resolveControlPlaneProfileEndpointInput,
  saveControlPlaneProfile,
  syncSharedControlPlaneProfiles,
  summarizeControlPlaneProfileNodes
} from '@/services/control-plane-profiles';
import {
  getActiveControlPlaneProfileId,
  resolveStoredActiveControlPlaneProfile,
  selectActiveControlPlaneProfile,
  syncStoredActiveControlPlaneProfile
} from '@/services/control-plane-selection';
import { getBrowserControlEndpoint } from '@/services/control-plane-endpoints';
import { resolveCurrentDeviceIdentity } from '@/services/device-identity';
import type { ControlPlaneProfile, ControlPlaneProfileConnectionMode } from '@/types';
import Button from '@/components/ui/AppButton';
import PageScaffold from '@/components/ui/PageScaffold';
import SectionCard from '@/components/ui/SectionCard';
import ListTable from '@/components/ui/ListTable';

type PairFormValues = {
  pairUrlOrCode?: string;
  endpoint?: string;
  connectionMode?: ControlPlaneProfileConnectionMode;
  brokerEndpoint?: string;
  brokerServerId?: string;
  deviceName?: string;
  platform?: string;
};

type SaveFormValues = {
  endpoint?: string;
  connectionMode?: ControlPlaneProfileConnectionMode;
  brokerEndpoint?: string;
  brokerServerId?: string;
  name?: string;
  deviceToken?: string;
};

type ConnectionFormValues = Pick<
  PairFormValues,
  'endpoint' | 'connectionMode' | 'brokerEndpoint' | 'brokerServerId'
>;

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
  if (profile.state === 'revoked') return { color: 'red', label: 'revoked' };
  return { color: 'gold', label: profile.authState === 'paired' ? 'paired' : 'needs pairing' };
}

function formatProfileDetail(profile: ControlPlaneProfile) {
  const nodeSummary = summarizeControlPlaneProfileNodes(profile);
  const chunks = [
    `${nodeSummary.online}/${nodeSummary.total} 节点在线`,
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
  const location = useLocation();
  const deviceIdentity = useMemo(() => resolveCurrentDeviceIdentity(), []);
  const [pairForm] = Form.useForm<PairFormValues>();
  const [saveForm] = Form.useForm<SaveFormValues>();
  const [initialState] = useState(getInitialServerSetupState);
  const [profiles, setProfiles] = useState<ControlPlaneProfile[]>(initialState.profiles);
  const [activeProfileId, setActiveProfileId] = useState(initialState.activeProfileId);
  const [checkingId, setCheckingId] = useState('');
  const [saving, setSaving] = useState(false);
  const [pairing, setPairing] = useState(false);
  const [setupModalOpen, setSetupModalOpen] = useState(false);
  const [setupModalTab, setSetupModalTab] = useState<'pair' | 'manual'>('pair');
  const [pendingAutoPairSubmit, setPendingAutoPairSubmit] = useState(false);
  const autoPairSubmittedSearchRef = useRef('');

  const openSetupModal = (tab: 'pair' | 'manual') => {
    setSetupModalTab(tab);
    setSetupModalOpen(true);
  };

  const activeProfile = profiles.find((profile) => profile.id === activeProfileId) || null;
  const readyProfiles = profiles.filter(isControlPlaneProfileReady);
  const defaultEndpoint = normalizeControlPlaneEndpoint(getBrowserControlEndpoint());
  const pairConnectionMode = normalizeConnectionMode(Form.useWatch('connectionMode', pairForm));
  const saveConnectionMode = normalizeConnectionMode(Form.useWatch('connectionMode', saveForm));
  const pairProxyPreview = buildProxyPreview(
    Form.useWatch('brokerEndpoint', pairForm),
    Form.useWatch('brokerServerId', pairForm)
  );
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
    const intent = parseControlPlanePairIntentFromSearch(location.search);
    const nextPairValues = {
      pairUrlOrCode: intent.pairUrlOrCode,
      connectionMode: 'direct' as const,
      endpoint: intent.endpoint || defaultEndpoint,
      deviceName: deviceIdentity.name,
      platform: deviceIdentity.platform
    };
    pairForm.setFieldsValue(nextPairValues);
    saveForm.setFieldsValue({
      connectionMode: 'direct',
      endpoint: intent.endpoint || defaultEndpoint,
      name: 'AIH Server'
    });
    if (intent.pairUrlOrCode) {
      setSetupModalTab('pair');
      setSetupModalOpen(true);
    }
    if (intent.autoSubmit && autoPairSubmittedSearchRef.current !== location.search) {
      autoPairSubmittedSearchRef.current = location.search;
      setPendingAutoPairSubmit(true);
    }
  }, [defaultEndpoint, deviceIdentity.name, deviceIdentity.platform, location.search, pairForm, saveForm]);

  useEffect(() => {
    if (!pendingAutoPairSubmit) return;
    if (!setupModalOpen || setupModalTab !== 'pair') return;
    setPendingAutoPairSubmit(false);
    pairForm.submit();
  }, [pendingAutoPairSubmit, setupModalOpen, setupModalTab, pairForm]);

  const handleSaveServer = async (values: SaveFormValues) => {
    setSaving(true);
    try {
      const resolved = resolveProfileEndpoint(values);
      const deviceToken = String(values.deviceToken || '').trim();
      const descriptor = await fetchControlPlaneDescriptor(resolved.endpoint);
      const profile = saveControlPlaneProfile({
        endpoint: resolved.endpoint,
        connectionMode: resolved.connectionMode,
        broker: resolved.broker,
        name: values.name || descriptor.endpoint || resolved.endpoint,
        descriptor,
        state: deviceToken ? 'paired' : 'discovered',
        authState: deviceToken ? 'paired' : 'unpaired',
        deviceToken,
        lastError: ''
      });
      if (deviceToken) {
        try {
          await refreshControlPlaneDeviceState(profile);
        } catch (error) {
          message.warning(`Server 已保存，但同步失败：${normalizeError(error)}`);
        }
      }
      syncProfiles(deviceToken ? profile.id : '');
      setSetupModalOpen(false);
      message.success(deviceToken ? 'Server 已保存并设为当前' : 'Server 已探测，下一步需要配对');
    } catch (error) {
      message.error(normalizeError(error));
    } finally {
      setSaving(false);
    }
  };

  const handlePairServer = async (values: PairFormValues) => {
    setPairing(true);
    try {
      const resolved = resolveProfileEndpoint(values);
      const paired = await pairControlPlaneDevice({
        pairUrlOrCode: values.pairUrlOrCode,
        endpoint: resolved.endpoint,
        connectionMode: resolved.connectionMode,
        broker: resolved.broker,
        deviceId: deviceIdentity.id,
        deviceName: values.deviceName || deviceIdentity.name,
        platform: values.platform || deviceIdentity.platform
      });
      try {
        await refreshControlPlaneDeviceState(paired.profile);
      } catch (error) {
        message.warning(`已配对，但同步摘要失败：${normalizeError(error)}`);
      }
      syncProfiles(paired.profile.id);
      setSetupModalOpen(false);
      pairForm.setFieldsValue({
        pairUrlOrCode: '',
        connectionMode: paired.profile.connectionMode,
        endpoint: paired.profile.endpoint,
        brokerEndpoint: paired.profile.broker?.brokerEndpoint || values.brokerEndpoint,
        brokerServerId: paired.profile.broker?.serverId || values.brokerServerId,
        deviceName: paired.device.name || deviceIdentity.name,
        platform: paired.device.platform || deviceIdentity.platform
      });
      message.success('Server 已配对并设为当前');
    } catch (error) {
      message.error(normalizeError(error));
    } finally {
      setPairing(false);
    }
  };

  const handleRefreshProfile = async (profile: ControlPlaneProfile) => {
    setCheckingId(profile.id);
    try {
      if (profile.deviceToken) {
        await refreshControlPlaneDeviceState(profile);
        message.success('Server 已同步');
      } else {
        const descriptor = await fetchControlPlaneDescriptor(profile.endpoint);
        saveControlPlaneProfile({
          name: profile.name,
          endpoint: profile.endpoint,
          descriptor,
          state: 'discovered',
          authState: profile.authState,
          deviceToken: profile.deviceToken,
          lastError: ''
        });
        message.success('Server 探测正常');
      }
      syncProfiles();
    } catch (error) {
      saveControlPlaneProfile({
        name: profile.name,
        endpoint: profile.endpoint,
        descriptor: profile.descriptor,
        state: 'degraded',
        authState: profile.authState,
        deviceToken: profile.deviceToken,
        lastError: normalizeError(error)
      });
      syncProfiles();
      message.error(normalizeError(error));
    } finally {
      setCheckingId('');
    }
  };

  const handleRemoveProfile = (profileId: string) => {
    removeControlPlaneProfile(profileId);
    syncProfiles();
  };

  const handleSelectProfile = (profileId: string) => {
    const resolution = selectActiveControlPlaneProfile(profiles, profileId);
    setActiveProfileId(resolution.profileId);
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
              {record.deviceToken ? '同步' : '探测'}
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
      title="选择或添加 Server"
      subTitle="配对或管理 AIH 控制面 Server"
      headerContent={
        new URLSearchParams(location.search).get('gate') === '1' ? (
          <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
            此浏览器尚未与当前 server 配对，未授权看不到数据。在 server 所在机器终端运行{' '}
            <Typography.Text code>aih fabric profile invite</Typography.Text>，打开打印的 browser url 完成配对。
          </Typography.Paragraph>
        ) : undefined
      }
      extra={
        <Space size={8} wrap>
          <Button icon={<PlusOutlined />} onClick={() => openSetupModal('pair')}>
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
          <Button type="link" href="/ui/fabric/control-planes" style={{ padding: 0 }}>
            打开高级控制面设置
          </Button>
        </div>
      </SectionCard>

      <Modal
        title="添加或迁移 Server"
        open={setupModalOpen}
        width={760}
        footer={null}
        destroyOnClose={false}
        forceRender
        onCancel={() => setSetupModalOpen(false)}
      >
        <Tabs
          activeKey={setupModalTab}
          onChange={(key) => setSetupModalTab(key as any)}
          items={[
            {
              key: 'pair',
              label: '通过配对添加',
              children: (
                <Form
                  form={pairForm}
                  layout="vertical"
                  onFinish={handlePairServer}
                  initialValues={{
                    pairUrlOrCode: '',
                    connectionMode: 'direct',
                    endpoint: defaultEndpoint,
                    brokerEndpoint: '',
                    brokerServerId: '',
                    deviceName: deviceIdentity.name,
                    platform: deviceIdentity.platform
                  }}
                >
                  <Form.Item
                    name="pairUrlOrCode"
                    label="Pair URL / Code"
                    rules={[{ required: true, message: '请输入 Pair URL 或 Code' }]}
                  >
                    <Input.TextArea
                      autoSize={{ minRows: 2, maxRows: 4 }}
                      placeholder="https://aih.example.com/ui/server-setup?pair=... 或一次性 code"
                    />
                  </Form.Item>
                  <Form.Item name="connectionMode" label="连接模式">
                    <Segmented block options={CONNECTION_MODE_OPTIONS} />
                  </Form.Item>
                  {pairConnectionMode === 'broker-proxy' ? (
                    <>
                      <Row gutter={12}>
                        <Col xs={24} sm={14}>
                          <Form.Item
                            name="brokerEndpoint"
                            label="Broker Endpoint"
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
                        <Input value={pairProxyPreview} readOnly placeholder="自动生成" />
                      </Form.Item>
                    </>
                  ) : (
                    <Form.Item name="endpoint" label="Server Endpoint">
                      <Input placeholder="https://aih.example.com" />
                    </Form.Item>
                  )}
                  <Row gutter={12}>
                    <Col xs={24} sm={12}>
                      <Form.Item name="deviceName" label="设备名称">
                        <Input placeholder="Mac / iPhone / Web" />
                      </Form.Item>
                    </Col>
                    <Col xs={24} sm={12}>
                      <Form.Item name="platform" label="Platform">
                        <Input placeholder="macos / ios / web" />
                      </Form.Item>
                    </Col>
                  </Row>
                  <Button type="primary" htmlType="submit" icon={<LinkOutlined />} loading={pairing}>
                    配对并进入
                  </Button>
                </Form>
              )
            },
            {
              key: 'manual',
              label: '探测并保存',
              children: (
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
                    deviceToken: ''
                  }}
                >
                  <Form.Item name="connectionMode" label="连接模式">
                    <Segmented block options={CONNECTION_MODE_OPTIONS} />
                  </Form.Item>
                  {saveConnectionMode === 'broker-proxy' ? (
                    <>
                      <Row gutter={12}>
                        <Col xs={24} sm={14}>
                          <Form.Item
                            name="brokerEndpoint"
                            label="Broker Endpoint"
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
                      label="Server URL"
                      rules={[{ required: true, message: '请输入 Server URL' }]}
                    >
                      <Input placeholder="https://aih.example.com" />
                    </Form.Item>
                  )}
                  <Form.Item name="name" label="显示名称">
                    <Input placeholder="Home Fabric / Company Fabric" />
                  </Form.Item>
                  <Form.Item name="deviceToken" label="Device Token">
                    <Input.Password autoComplete="new-password" placeholder="可选；配对后返回的一次性 token" />
                  </Form.Item>
                  <Button type="primary" htmlType="submit" icon={<CheckCircleOutlined />} loading={saving}>
                    探测并保存
                  </Button>
                </Form>
              )
            }
          ]}
        />
      </Modal>
    </PageScaffold>
  );
}
