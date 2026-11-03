import { useState } from 'react';
import { Input, List, Space, Tag, Typography } from 'antd';
import Button from '@/components/ui/AppButton';
import { aggregatorErrorText, responseErrorCode } from './aggregator-presentation';
import { subscriptionAggregatorAPI } from './subscription-aggregator-api';
import type { AggregatorProbePort, AggregatorProbeResult } from './types';
import styles from './SubscriptionAggregator.module.css';

const { Text } = Typography;

interface ProbePanelProps {
  /** 选一个端口的结果填进表单 */
  onUse: (result: AggregatorProbeResult, port: AggregatorProbePort, protocol: string) => void;
}

function parsePorts(text: string) {
  return [...new Set(text.split(/[\s,，]+/).filter(Boolean).map(Number))];
}

/**
 * 探针：只知道地址（和端口）时，从服务器探测 DNS、TCP、TLS、SOCKS5、HTTP 代理、SSH，
 * 猜出可能的协议，再一键填进手动节点表单。不填端口时试常见端口。
 */
export default function ProbePanel({ onUse }: ProbePanelProps) {
  const [host, setHost] = useState('');
  const [portsText, setPortsText] = useState('');
  const [result, setResult] = useState<AggregatorProbeResult | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const run = async () => {
    const ports = parsePorts(portsText);
    if (!host.trim()) return;
    if (ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)) {
      setError('端口要是 1–65535 的整数，多个用逗号分隔');
      return;
    }
    setLoading(true);
    setError('');
    try {
      setResult(await subscriptionAggregatorAPI.probe(host.trim(), ports));
    } catch (probeError) {
      setResult(null);
      setError(aggregatorErrorText(responseErrorCode(probeError), '探测失败'));
    } finally {
      setLoading(false);
    }
  };

  const openPorts = (result?.ports || []).filter((port) => port.open);
  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <div className={styles.probeRow}>
        <Input value={host} onChange={(event) => setHost(event.target.value)} onPressEnter={() => void run()} placeholder="节点域名或 IP" aria-label="探测地址" />
        <Input value={portsText} onChange={(event) => setPortsText(event.target.value)} onPressEnter={() => void run()} placeholder="端口（可多个，留空试常见端口）" aria-label="探测端口" />
        <Button type="primary" loading={loading} onClick={() => void run()}>探测</Button>
      </div>
      <Text type="secondary">从服务器发起探测。Hysteria2、TUIC、WireGuard 走 UDP，没有凭据探不出来。</Text>
      {error ? <Text type="danger">{error}</Text> : null}
      {result?.dnsError ? <Text type="danger">域名解析失败（{result.dnsError}）</Text> : null}
      {result?.fakeIp ? <Text type="warning">本机代理接管了 DNS（fake-ip），连接实际连到本机代理，结果不代表节点本身。</Text> : null}
      {result && !result.dnsError && (
        <List
          size="small"
          dataSource={openPorts.length ? openPorts : result.ports}
          locale={{ emptyText: '没有开放的端口' }}
          renderItem={(port) => (
            <List.Item
              actions={port.candidates.length ? [
                <Button key="use" size="small" onClick={() => onUse(result, port, port.candidates[0])}>填入表单</Button>
              ] : undefined}
            >
              <List.Item.Meta
                title={(
                  <Space size={6} wrap>
                    <span>端口 {port.port}</span>
                    {port.open ? <Tag color="success">{port.latencyMs} ms</Tag> : <Tag>{port.error || '关闭'}</Tag>}
                    {port.candidates.slice(0, 4).map((candidate) => <Tag key={candidate}>{candidate}</Tag>)}
                  </Space>
                )}
                description={port.note || null}
              />
            </List.Item>
          )}
        />
      )}
      {result && !result.dnsError && openPorts.length > 0 && openPorts.length < result.ports.length ? (
        <Text type="secondary">另有 {result.ports.length - openPorts.length} 个端口未开放。</Text>
      ) : null}
    </Space>
  );
}
