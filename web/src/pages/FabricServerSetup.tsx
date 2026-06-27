import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Alert, Button, Form, Input, Segmented, Space, Tag, message } from 'antd';
import {
  CheckCircleOutlined,
  DownloadOutlined,
  DeleteOutlined,
  LinkOutlined,
  LoginOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  UploadOutlined
} from '@ant-design/icons';
import {
  buildFabricBrokerProxyEndpoint,
  fetchControlPlaneDescriptor,
  importControlPlaneProfileBundle,
  isControlPlaneProfileReady,
  listControlPlaneProfiles,
  normalizeControlPlaneEndpoint,
  pairControlPlaneDevice,
  parseControlPlanePairIntentFromSearch,
  refreshControlPlaneDeviceState,
  removeControlPlaneProfile,
  resolveControlPlaneProfileEndpointInput,
  saveControlPlaneProfile,
  serializeControlPlaneProfileBundle,
  syncSharedControlPlaneProfiles,
  summarizeControlPlaneProfileNodes
} from '@/services/control-plane-profiles';
import {
  getActiveControlPlaneProfileId,
  resolveStoredActiveControlPlaneProfile,
  selectActiveControlPlaneProfile,
  syncStoredActiveControlPlaneProfile
} from '@/services/control-plane-selection';
import {
  getBrowserControlEndpoint,
  isLoopbackEndpoint
} from '@/services/control-plane-endpoints';
import { resolveCurrentDeviceIdentity } from '@/services/device-identity';
import type { ControlPlaneProfile, ControlPlaneProfileConnectionMode } from '@/types';
import './FabricServerSetup.css';

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

type ImportFormValues = {
  bundle?: string;
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
  const [importForm] = Form.useForm<ImportFormValues>();
  const [initialState] = useState(getInitialServerSetupState);
  const [profiles, setProfiles] = useState<ControlPlaneProfile[]>(initialState.profiles);
  const [activeProfileId, setActiveProfileId] = useState(initialState.activeProfileId);
  const [checkingId, setCheckingId] = useState('');
  const [saving, setSaving] = useState(false);
  const [pairing, setPairing] = useState(false);
  const [importing, setImporting] = useState(false);
  const autoPairSubmittedRef = useRef(false);

  const activeProfile = profiles.find((profile) => profile.id === activeProfileId) || null;
  const readyProfiles = profiles.filter(isControlPlaneProfileReady);
  const defaultEndpoint = normalizeControlPlaneEndpoint(getBrowserControlEndpoint());
  const endpointIsLoopback = isLoopbackEndpoint(defaultEndpoint);
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
    if (intent.autoSubmit && !autoPairSubmittedRef.current) {
      autoPairSubmittedRef.current = true;
      pairForm.submit();
    }
  }, [defaultEndpoint, deviceIdentity.name, deviceIdentity.platform, location.search, pairForm, saveForm]);

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

  const downloadProfileBundle = (targets: ControlPlaneProfile[], scope: 'active' | 'all') => {
    const items = targets.filter(Boolean);
    if (items.length === 0) {
      message.warning('没有可导出的 Server Profile');
      return;
    }
    const payload = serializeControlPlaneProfileBundle(items);
    const blob = new Blob([payload], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `aih-server-profiles-${scope}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    message.success(`已导出 ${items.length} 个 Server Profile，不包含 device token`);
  };

  const handleExportActiveProfile = () => {
    if (!activeProfile) {
      message.warning('请先选择一个 Server Profile');
      return;
    }
    downloadProfileBundle([activeProfile], 'active');
  };

  const handleExportAllProfiles = () => {
    downloadProfileBundle(profiles, 'all');
  };

  const handleImportProfileBundle = async (values: ImportFormValues) => {
    setImporting(true);
    try {
      const result = importControlPlaneProfileBundle(values.bundle || '');
      const firstProfileId = result.imported[0]?.profile.id || '';
      syncProfiles(firstProfileId);
      importForm.setFieldsValue({ bundle: '' });
      message.success(`已导入 ${result.imported.length} 个 Server Profile，需重新配对后进入`);
    } catch (error) {
      message.error(normalizeError(error));
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="fabric-server-setup-page animate__animated animate__fadeIn animate__faster">
      <section className="fabric-server-setup-header">
        <div>
          <span>AIH Fabric</span>
          <h1>选择或添加 Server</h1>
          <p>先确定当前 client 连接哪个 AIH server，再进入节点、项目和原生会话。</p>
        </div>
        <Space size={8} wrap>
          <Tag color={readyProfiles.length > 0 ? 'green' : 'gold'}>
            {readyProfiles.length} ready
          </Tag>
          <Tag>{profiles.length} profiles</Tag>
        </Space>
      </section>

      {endpointIsLoopback && (
        <Alert
          className="fabric-server-setup-alert"
          type="warning"
          showIcon
          message="当前默认 endpoint 是 loopback"
          description="127.0.0.1 / localhost 只适合同机访问；手机或另一台电脑需要填写局域网、隧道、WSS relay 或公网 HTTPS endpoint。"
        />
      )}

      <div className="fabric-server-setup-grid">
        <section className="fabric-server-setup-panel fabric-server-setup-panel--primary">
          <div className="fabric-server-setup-panel-head">
            <div>
              <h2>通过配对添加</h2>
              <p>粘贴 pair URL，或输入 code + endpoint。完成后会保存 device token 并设为当前 server。</p>
            </div>
            <SafetyCertificateOutlined />
          </div>
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
                <div className="fabric-server-setup-form-row">
                  <Form.Item
                    name="brokerEndpoint"
                    label="Broker Endpoint"
                    rules={[{ required: true, message: '请输入 Broker Endpoint' }]}
                  >
                    <Input placeholder="https://broker.example.com" />
                  </Form.Item>
                  <Form.Item
                    name="brokerServerId"
                    label="Server ID"
                    rules={[{ required: true, message: '请输入 Server ID' }]}
                  >
                    <Input placeholder="aws-current" />
                  </Form.Item>
                </div>
                <Form.Item label="Proxy Endpoint">
                  <Input value={pairProxyPreview} readOnly placeholder="自动生成" />
                </Form.Item>
              </>
            ) : (
              <Form.Item name="endpoint" label="Server Endpoint">
                <Input placeholder="https://aih.example.com" />
              </Form.Item>
            )}
            <div className="fabric-server-setup-form-row">
              <Form.Item name="deviceName" label="设备名称">
                <Input placeholder="Mac / iPhone / Web" />
              </Form.Item>
              <Form.Item name="platform" label="Platform">
                <Input placeholder="macos / ios / web" />
              </Form.Item>
            </div>
            <Button type="primary" htmlType="submit" icon={<LinkOutlined />} loading={pairing}>
              配对并进入
            </Button>
          </Form>
        </section>

        <section className="fabric-server-setup-panel">
          <div className="fabric-server-setup-panel-head">
            <div>
              <h2>探测并保存</h2>
              <p>先读取 server descriptor；没有 device token 时只保存为待配对 profile。</p>
            </div>
            <CheckCircleOutlined />
          </div>
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
                <div className="fabric-server-setup-form-row">
                  <Form.Item
                    name="brokerEndpoint"
                    label="Broker Endpoint"
                    rules={[{ required: true, message: '请输入 Broker Endpoint' }]}
                  >
                    <Input placeholder="https://broker.example.com" />
                  </Form.Item>
                  <Form.Item
                    name="brokerServerId"
                    label="Server ID"
                    rules={[{ required: true, message: '请输入 Server ID' }]}
                  >
                    <Input placeholder="aws-current" />
                  </Form.Item>
                </div>
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
        </section>
      </div>

      <section className="fabric-server-setup-panel fabric-server-setup-panel--wide">
        <div className="fabric-server-setup-panel-head">
          <div>
            <h2>迁移 Server Profile</h2>
            <p>导出 endpoint、descriptor 和能力摘要；device token 不会写入 bundle，导入后需要重新配对。</p>
          </div>
          <UploadOutlined />
        </div>
        <div className="fabric-server-setup-transfer-grid">
          <div className="fabric-server-setup-transfer-actions">
            <Button icon={<DownloadOutlined />} disabled={!activeProfile} onClick={handleExportActiveProfile}>
              导出当前
            </Button>
            <Button icon={<DownloadOutlined />} disabled={profiles.length === 0} onClick={handleExportAllProfiles}>
              导出全部
            </Button>
          </div>
          <Form form={importForm} layout="vertical" onFinish={handleImportProfileBundle}>
            <Form.Item
              name="bundle"
              label="Profile Bundle JSON"
              rules={[{ required: true, message: '请粘贴 profile bundle JSON' }]}
            >
              <Input.TextArea
                autoSize={{ minRows: 4, maxRows: 8 }}
                placeholder='{"kind":"aih-control-plane-profile-bundle","version":1,...}'
              />
            </Form.Item>
            <Button type="primary" htmlType="submit" icon={<UploadOutlined />} loading={importing}>
              导入 Profile
            </Button>
          </Form>
        </div>
      </section>

      <section className="fabric-server-setup-panel fabric-server-setup-panel--wide">
        <div className="fabric-server-setup-panel-head">
          <div>
            <h2>已保存 Server</h2>
            <p>业务页面只会在当前 server ready 后开放。未配对 server 可继续保留用于后续配对。</p>
          </div>
          <Button
            type="primary"
            icon={<LoginOutlined />}
            disabled={!activeProfile || !isControlPlaneProfileReady(activeProfile)}
            onClick={() => navigate('/')}
          >
            进入工作台
          </Button>
        </div>
        <div className="fabric-server-setup-profile-list">
          {profiles.length === 0 ? (
            <Alert type="info" showIcon message="暂无 server profile" />
          ) : profiles.map((profile) => {
            const status = getProfileStatus(profile);
            const active = profile.id === activeProfileId;
            return (
              <div
                key={profile.id}
                className={`fabric-server-setup-profile${active ? ' fabric-server-setup-profile--active' : ''}`}
              >
                <div className="fabric-server-setup-profile-main">
                  <strong>{profile.name || profile.endpoint}</strong>
                  <span>{profile.endpoint}</span>
                  {profile.lastError && <em>{profile.lastError}</em>}
                </div>
                <div className="fabric-server-setup-profile-meta">
                  {active && <Tag color="green">当前</Tag>}
                  {profile.connectionMode === 'broker-proxy' && <Tag color="blue">Broker</Tag>}
                  {profile.broker?.serverId && <Tag>{profile.broker.serverId}</Tag>}
                  <Tag color={status.color}>{status.label}</Tag>
                  <Tag>{formatProfileDetail(profile)}</Tag>
                </div>
                <Space size={6} wrap className="fabric-server-setup-profile-actions">
                  <Button size="small" disabled={active} onClick={() => handleSelectProfile(profile.id)}>
                    设为当前
                  </Button>
                  <Button
                    size="small"
                    icon={<ReloadOutlined />}
                    loading={checkingId === profile.id}
                    onClick={() => handleRefreshProfile(profile)}
                  >
                    {profile.deviceToken ? '同步' : '探测'}
                  </Button>
                  <Button
                    size="small"
                    danger
                    icon={<DeleteOutlined />}
                    onClick={() => handleRemoveProfile(profile.id)}
                  >
                    移除
                  </Button>
                </Space>
              </div>
            );
          })}
        </div>
        <a className="fabric-server-setup-advanced-link" href="/ui/fabric/control-planes">
          打开高级控制面设置
        </a>
        <a className="fabric-server-setup-advanced-link" href="/ui/fabric/webrtc-lab">
          打开 WebRTC DataChannel Lab
        </a>
      </section>
    </div>
  );
}
