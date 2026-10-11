import { useMemo, useState } from 'react';
import { Input, Select, Space } from 'antd';
import { CopyOutlined } from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import { copyText } from '@/components/toolkit/proxy-pool/proxy-pool-utils';
import { resolveActiveServerOrigin } from '@/services/webui-auth-transport';
import { buildSubscriptionUrl, linkFormatOptions, type SubscriptionLinkFormat } from './aggregator-presentation';
import type { AggregatorFormatInfo } from './types';

interface SubscriptionLinkFieldProps {
  path: string;
  name: string;
  /** 服务端 catalog.formats */
  formats: AggregatorFormatInfo[];
  /** 窄屏把格式选择放到链接上方，链接独占一行 */
  stacked?: boolean;
}

/** 订阅链接 + 格式选择 + 复制。「自动识别」让服务端按客户端 User-Agent 选择格式。 */
export default function SubscriptionLinkField({ path, name, formats, stacked = false }: SubscriptionLinkFieldProps) {
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
        {formatSelect}
        <Space.Compact block>{linkRow}</Space.Compact>
      </Space>
    );
  }
  return (
    <Space.Compact block>
      {formatSelect}
      {linkRow}
    </Space.Compact>
  );
}
