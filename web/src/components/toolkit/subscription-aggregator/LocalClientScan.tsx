import { useEffect, useMemo, useState } from 'react';
import { Checkbox, Empty, List, Space, Tag, Typography } from 'antd';
import { ScanOutlined } from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import { maskSourceUrl } from './aggregator-presentation';
import type { AggregatorLocalCandidate, AggregatorLocalScan } from './types';

const { Text } = Typography;

interface LocalClientScanProps {
  /** 弹窗打开即自动扫一次；之后可以手动重扫。 */
  active: boolean;
  scanning: boolean;
  onScan: () => Promise<AggregatorLocalScan | null>;
  selected: Set<string>;
  onSelectedChange: (next: Set<string>) => void;
}

/**
 * 扫描本机代理客户端（Clash Verge / Clash 系 / Surge / v2rayN）：列出配置里的订阅地址，
 * 地址与已有订阅源相同的标「已导入」并禁用勾选。扫描只读，不改客户端配置。
 */
export default function LocalClientScan({ active, scanning, onScan, selected, onSelectedChange }: LocalClientScanProps) {
  const [scan, setScan] = useState<AggregatorLocalScan | null>(null);
  const [scanned, setScanned] = useState(false);

  const runScan = async () => {
    const result = await onScan();
    setScanned(true);
    setScan(result);
    // 默认勾上全部「新的」：能扫到多少导入多少。
    onSelectedChange(new Set((result?.candidates || []).filter((candidate) => !candidate.imported).map((candidate) => candidate.id)));
  };

  useEffect(() => {
    if (active && !scanned && !scanning) void runScan();
    // 只在第一次切到这个页签时自动扫描。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const candidates = scan?.candidates || [];
  const fresh = useMemo(() => candidates.filter((candidate) => !candidate.imported), [candidates]);
  const foundClients = (scan?.clients || []).filter((client) => client.found > 0);
  const toggle = (candidate: AggregatorLocalCandidate, checked: boolean) => {
    const next = new Set(selected);
    if (checked) next.add(candidate.id);
    else next.delete(candidate.id);
    onSelectedChange(next);
  };
  const allChecked = fresh.length > 0 && fresh.every((candidate) => selected.has(candidate.id));

  return (
    <div>
      <Space wrap style={{ marginBottom: 12 }}>
        <Button icon={<ScanOutlined />} loading={scanning} disabled={scanning} onClick={() => void runScan()}>
          {scanned ? '重新扫描' : '扫描本机客户端'}
        </Button>
        {fresh.length > 0 && (
          <Checkbox
            checked={allChecked}
            indeterminate={!allChecked && fresh.some((candidate) => selected.has(candidate.id))}
            onChange={(event) => onSelectedChange(new Set(event.target.checked ? fresh.map((candidate) => candidate.id) : []))}
          >
            全选可导入（{fresh.length}）
          </Checkbox>
        )}
      </Space>
      <Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>
        只读扫描本机的 Clash Verge、ClashX / FlClash / mihomo、Surge、v2rayN 配置；订阅地址与已有订阅源相同的会标为「已导入」。
      </Text>
      {scan && (
        <Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>
          {foundClients.length
            ? `找到 ${foundClients.map((client) => `${client.name} ${client.found} 条`).join('、')}，去重后 ${candidates.length} 个订阅，其中 ${fresh.length} 个可导入`
            : '这台机器上没有找到这些客户端的订阅配置'}
        </Text>
      )}
      <List
        size="small"
        bordered
        loading={scanning}
        dataSource={candidates}
        style={{ maxHeight: 360, overflowY: 'auto' }}
        locale={{ emptyText: <Empty description={scanned ? '没有发现可导入的订阅地址' : '点击「扫描本机客户端」开始'} /> }}
        renderItem={(candidate) => (
          <List.Item>
            <Checkbox
              checked={candidate.imported || selected.has(candidate.id)}
              disabled={candidate.imported}
              onChange={(event) => toggle(candidate, event.target.checked)}
              style={{ width: '100%', minWidth: 0 }}
            >
              <Space size={6} wrap>
                <strong>{candidate.name}</strong>
                <Tag>{candidate.clientName}</Tag>
                {candidate.imported
                  ? <Tag color="default">已导入 · {candidate.importedSourceName}</Tag>
                  : <Tag color="blue">新订阅</Tag>}
              </Space>
              <Text type="secondary" code style={{ display: 'block', marginTop: 2, wordBreak: 'break-all' }} title="订阅参数已隐藏">
                {maskSourceUrl(candidate.url)}
              </Text>
            </Checkbox>
          </List.Item>
        )}
      />
    </div>
  );
}
