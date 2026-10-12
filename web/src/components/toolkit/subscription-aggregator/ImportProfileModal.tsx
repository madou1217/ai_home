import { useCallback, useEffect, useMemo, useState } from 'react';
import { List, Modal, QRCode, Segmented, Select, Space, Spin, Tag, Typography } from 'antd';
import { CopyOutlined, DownloadOutlined, ExportOutlined } from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import InlineNote from '@/components/ui/InlineNote';
import { copyText } from '@/components/toolkit/proxy-pool/proxy-pool-utils';
import { serverProfilesAPI } from '@/services/api';
import { resolveActiveServerOrigin } from '@/services/webui-auth-transport';
import type { ControlPlaneEndpointHint } from '@/types';
import { aggregatorErrorText, isLoopbackOrigin, sortImportClients } from './aggregator-presentation';
import { subscriptionAggregatorAPI } from './subscription-aggregator-api';
import type {
  AggregatorFormatInfo,
  AggregatorImportClient,
  AggregatorImportLinks,
  AggregatorLocalClients,
  AggregatorProfile
} from './types';

const { Paragraph, Text } = Typography;

type ImportTab = 'desktop' | 'mobile';

interface ImportProfileModalProps {
  profile: AggregatorProfile | null;
  formats: AggregatorFormatInfo[];
  onClose: () => void;
  width?: number | string;
  /** 打开时的页签：桌面默认本机客户端，移动端默认扫码 */
  defaultTab?: ImportTab;
}

interface OriginOption {
  value: string;
  label: string;
  warning: string;
  recommended: boolean;
}

function errorCode(error: unknown) {
  return (error as { response?: { data?: { error?: string } } })?.response?.data?.error;
}

/** 可选的服务地址：当前浏览器地址 + 服务端给出的局域网候选（去重）。 */
function buildOriginOptions(current: string, hints: ControlPlaneEndpointHint[]): OriginOption[] {
  const options: OriginOption[] = [];
  const add = (value: string, label: string, warning = '', recommended = false) => {
    if (value && !options.some((option) => option.value === value)) options.push({ value, label, warning, recommended });
  };
  add(current, '当前浏览器地址');
  hints.forEach((hint) => add(hint.endpoint.replace(/\/+$/, ''), hint.label, hint.warning || '', hint.recommended === true));
  return options;
}

/** 扫码默认用手机能访问的地址：推荐的非本机地址优先。 */
function defaultMobileOrigin(options: OriginOption[]) {
  const reachable = options.filter((option) => !isLoopbackOrigin(option.value));
  return (reachable.find((option) => option.recommended) || reachable[0] || options[0])?.value || '';
}

/**
 * 一键导入：本机客户端（深链接直接拉起应用，已安装的排前面）与手机扫码（通用地址或某个客户端的深链接）。
 * 订阅地址的服务地址可以切换：手机扫码要选局域网地址。
 */
export default function ImportProfileModal({ profile, formats, onClose, width = 720, defaultTab = 'desktop' }: ImportProfileModalProps) {
  const [tab, setTab] = useState<ImportTab>(defaultTab);
  const [originOptions, setOriginOptions] = useState<OriginOption[]>([]);
  const [origins, setOrigins] = useState<Record<ImportTab, string>>({ desktop: '', mobile: '' });
  const [links, setLinks] = useState<AggregatorImportLinks | null>(null);
  const [localClients, setLocalClients] = useState<AggregatorLocalClients | null>(null);
  const [mobileClient, setMobileClient] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!profile) return;
    setTab(defaultTab);
    setMobileClient('');
    setLinks(null);
    setError('');
    const current = resolveActiveServerOrigin();
    void Promise.all([
      serverProfilesAPI.listEndpointHints().catch(() => ({ endpoints: [] as ControlPlaneEndpointHint[] })),
      subscriptionAggregatorAPI.localClients().catch(() => null)
    ]).then(([hints, local]) => {
      const options = buildOriginOptions(current, hints.endpoints);
      setOriginOptions(options);
      setOrigins({ desktop: current, mobile: defaultMobileOrigin(options) });
      setLocalClients(local);
    });
  }, [defaultTab, profile]);

  // 扫码页打开期间让 HUD 的 CRT 扫描线让开（见 styles/hud.css 的 data-qr-visible）。
  useEffect(() => {
    if (!profile || tab !== 'mobile') return undefined;
    document.documentElement.setAttribute('data-qr-visible', '');
    return () => document.documentElement.removeAttribute('data-qr-visible');
  }, [profile, tab]);

  const origin = origins[tab];
  const load = useCallback(async (profileId: string, nextOrigin: string) => {
    setLoading(true);
    setError('');
    try {
      setLinks(await subscriptionAggregatorAPI.importLinks(profileId, nextOrigin));
    } catch (loadError) {
      setError(aggregatorErrorText(errorCode(loadError), '生成导入链接失败'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (profile && origin) void load(profile.id, origin);
  }, [load, origin, profile]);

  const formatName = (id: string) => (id ? formats.find((item) => item.id === id)?.name || id : '按客户端自动选择');
  const handlers = useMemo(() => localClients?.handlers || {}, [localClients]);
  const desktopClients = useMemo(
    () => sortImportClients((links?.clients || []).filter((client) => client.devices.includes('desktop')), handlers),
    [handlers, links]
  );
  const mobileClients = (links?.clients || []).filter((client) => client.devices.includes('mobile'));
  const selectedMobile = mobileClients.find((client) => client.id === mobileClient) || null;
  const qrValue = selectedMobile ? selectedMobile.link || selectedMobile.url : links?.url || '';
  const originWarning = originOptions.find((option) => option.value === origin)?.warning || '';

  const clientTags = (client: AggregatorImportClient) => (
    <Space size={4} wrap>
      <Tag>{formatName(client.format)}{client.view === 'nodes' ? '（仅节点）' : ''}</Tag>
      {client.scheme && handlers[client.scheme] ? <Tag color="success">本机已安装 · {handlers[client.scheme]}</Tag> : null}
      {!client.verified ? <Tag color="warning">待实测</Tag> : null}
    </Space>
  );

  const desktopAction = (client: AggregatorImportClient) => {
    if (client.link) {
      return <Button key="open" type="primary" size="small" icon={<ExportOutlined />} href={client.link}>导入</Button>;
    }
    if (client.download) {
      return <Button key="download" type="primary" size="small" icon={<DownloadOutlined />} href={client.url}>下载配置</Button>;
    }
    return (
      <Button key="copy" size="small" icon={<CopyOutlined />} onClick={() => void copyText(client.url, '订阅地址已复制')}>
        复制地址
      </Button>
    );
  };

  const originSelect = (
    <Select
      aria-label="订阅地址使用的服务地址"
      value={origin || undefined}
      onChange={(value) => setOrigins((current) => ({ ...current, [tab]: value }))}
      options={originOptions.map((option) => ({ value: option.value, label: `${option.label} · ${option.value}` }))}
      popupMatchSelectWidth={false}
      style={{ width: '100%' }}
    />
  );

  return (
    <Modal
      title={profile ? `导入到客户端 · ${profile.name}` : '导入到客户端'}
      open={Boolean(profile)}
      onCancel={onClose}
      footer={null}
      width={width}
      destroyOnHidden
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Segmented
          block
          value={tab}
          onChange={(value) => setTab(value as ImportTab)}
          options={[{ label: '本机客户端', value: 'desktop' }, { label: '手机扫码', value: 'mobile' }]}
        />
        {originSelect}
        {error ? <Text type="danger">{error}</Text> : null}
        {tab === 'desktop' ? (
          <>
            {localClients && !localClients.local ? (
              <InlineNote tone="info">
                WebUI 没有在服务器这台电脑上打开，检测不到本机装了哪些客户端；点「导入」时浏览器会尝试打开对应应用。
              </InlineNote>
            ) : null}
            <Spin spinning={loading}>
              <List
                dataSource={desktopClients}
                renderItem={(client) => (
                  <List.Item actions={[desktopAction(client)]}>
                    <List.Item.Meta
                      title={<Space size={8} wrap><span>{client.name}</span>{clientTags(client)}</Space>}
                      description={[client.apps, client.note].filter(Boolean).join('。') || null}
                    />
                  </List.Item>
                )}
              />
            </Spin>
          </>
        ) : (
          <>
            {isLoopbackOrigin(origin) ? (
              <InlineNote tone="warning">
                手机访问不到本机地址（localhost / 127.0.0.1），请在上面选局域网地址；如果服务只监听本机，需要先开启开放网络或接入隧道。
              </InlineNote>
            ) : originWarning ? <Text type="secondary">{originWarning}</Text> : null}
            <Select
              aria-label="扫码导入的客户端"
              value={mobileClient}
              onChange={setMobileClient}
              options={[
                { value: '', label: '通用订阅地址（客户端自动识别格式）' },
                ...mobileClients.map((client) => ({ value: client.id, label: client.verified ? client.name : `${client.name}（待实测）` }))
              ]}
              showSearch
              optionFilterProp="label"
              style={{ width: '100%' }}
            />
            <Space direction="vertical" align="center" style={{ width: '100%' }}>
              {qrValue ? <QRCode value={qrValue} size={220} color="#000000" bgColor="#ffffff" status={loading ? 'loading' : 'active'} /> : <Spin />}
              <Text type="secondary">
                {selectedMobile
                  ? 'iOS 用系统相机扫码会直接打开对应 App；Android 请在客户端里扫码。'
                  : 'FlClash、SFA、Hiddify、NekoBox、Husi、v2rayNG、Happ 等可以在客户端里直接扫这个地址。'}
              </Text>
              {selectedMobile ? clientTags(selectedMobile) : null}
              {selectedMobile?.note ? <Text type="secondary">{selectedMobile.note}</Text> : null}
            </Space>
            {qrValue ? <Paragraph copyable={{ text: qrValue }} ellipsis={{ rows: 2, expandable: true }} code>{qrValue}</Paragraph> : null}
          </>
        )}
      </Space>
    </Modal>
  );
}
