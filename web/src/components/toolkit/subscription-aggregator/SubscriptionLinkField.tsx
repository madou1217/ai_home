import { useMemo, useState } from 'react';
import { Descriptions, Input, Popover, Select, Space } from 'antd';
import { CopyOutlined, InfoCircleOutlined } from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import { copyText } from '@/components/toolkit/proxy-pool/proxy-pool-utils';
import { resolveActiveServerOrigin } from '@/services/webui-auth-transport';
import { buildSubscriptionUrl, groupClientsByFormat, linkFormatOptions, type SubscriptionLinkFormat } from './aggregator-presentation';
import type { AggregatorClientInfo, AggregatorFormatInfo } from './types';

interface SubscriptionLinkFieldProps {
  path: string;
  name: string;
  /** 服务端 catalog.formats */
  formats: AggregatorFormatInfo[];
  /** 服务端 catalog.clients：「自动识别」能认出的客户端 */
  clients: AggregatorClientInfo[];
  /** 窄屏把格式选择放到链接上方，链接独占一行 */
  stacked?: boolean;
}

/** 订阅链接 + 格式选择 + 复制。「自动识别」让服务端按客户端 User-Agent 选择格式。 */
export default function SubscriptionLinkField({ path, name, formats, clients, stacked = false }: SubscriptionLinkFieldProps) {
  const [format, setFormat] = useState<SubscriptionLinkFormat>('auto');
  const url = useMemo(() => buildSubscriptionUrl(resolveActiveServerOrigin(), path, format), [format, path]);
  const options = useMemo(() => linkFormatOptions(formats), [formats]);
  const formatSelect = (
    <Select
      aria-label={`${name} 订阅格式`}
      value={format}
      onChange={setFormat}
      options={options}
      popupMatchSelectWidth={false}
      style={stacked ? { width: '100%' } : { width: 170, flex: 'none' }}
    />
  );
  const clientsByFormat = useMemo(() => groupClientsByFormat(clients, formats), [clients, formats]);
  const clientList = (
    <Descriptions
      size="small"
      column={1}
      bordered
      items={clientsByFormat.map((group) => ({ key: group.format, label: group.formatName, children: group.clientNames.join('、') }))}
    />
  );
  const clientsButton = (
    <Popover
      title="自动识别：按客户端给对应格式"
      content={clientList}
      trigger="click"
      placement="bottomLeft"
      styles={{ root: { maxWidth: 'min(560px, calc(100vw - 32px))' } }}
    >
      <Button icon={<InfoCircleOutlined />} aria-label={`查看 ${name} 自动识别的客户端`} />
    </Popover>
  );
  const linkRow = (
    <>
      <Input readOnly value={url} aria-label={`${name} 订阅链接`} onFocus={(event) => event.target.select()} />
      <Button icon={<CopyOutlined />} aria-label={`复制 ${name} 订阅链接`} onClick={() => void copyText(url, '订阅链接已复制')}>
        复制
      </Button>
    </>
  );

  if (stacked) {
    return (
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <Space.Compact block>{formatSelect}{clientsButton}</Space.Compact>
        <Space.Compact block>{linkRow}</Space.Compact>
      </Space>
    );
  }
  return (
    <Space.Compact block>
      {formatSelect}
      {clientsButton}
      {linkRow}
    </Space.Compact>
  );
}
