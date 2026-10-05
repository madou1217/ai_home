import { useCallback, useEffect, useState } from 'react';
import { InputNumber, Space, Switch, Tag, Typography, message } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import { proxyPoolAPI } from '@/services/api';
import type { OutboundFailoverConfig, OutboundFailoverStatus, RoutingResponse } from '@/types';
import { getErrorMessage } from './proxy-pool-utils';
import { describeFailoverCheck, describeFailoverEvent, formatFailoverTime } from './outbound-failover-presentation';

const { Text, Title } = Typography;
const RECENT_EVENT_COUNT = 5;

interface ProxyOutboundFailoverSectionProps {
  open: boolean;
  dataPlaneReady: boolean;
  /** 立即检测触发切换后，用新的分流状态刷新外层 */
  onRoutingChanged: (response: RoutingResponse) => void;
}

/** 分流弹窗里的「默认出口自动切换」设置：开关、检测间隔、失败阈值、立即检测与最近切换记录。 */
export default function ProxyOutboundFailoverSection({ open, dataPlaneReady, onRoutingChanged }: ProxyOutboundFailoverSectionProps) {
  const [status, setStatus] = useState<OutboundFailoverStatus | null>(null);
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus(await proxyPoolAPI.getOutboundFailover());
    } catch (error) {
      message.error(getErrorMessage(error, '读取自动切换设置失败'));
    }
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const save = async (update: Partial<OutboundFailoverConfig>) => {
    setSaving(true);
    try {
      const result = await proxyPoolAPI.updateOutboundFailover(update);
      if (result.ok) setStatus(result);
      else message.error(result.error || '保存失败');
    } catch (error) {
      message.error(getErrorMessage(error, '保存自动切换设置失败'));
    } finally {
      setSaving(false);
    }
  };

  const commitNumber = (key: 'intervalSec' | 'failureThreshold', raw: string) => {
    const value = Number(raw);
    if (status && Number.isInteger(value) && value !== status.config[key]) void save({ [key]: value });
  };

  const checkNow = async () => {
    setChecking(true);
    try {
      const result = await proxyPoolAPI.checkOutboundFailover();
      const summary = describeFailoverCheck(result);
      if (result.action === 'switched') {
        message.success(summary.text);
        onRoutingChanged(await proxyPoolAPI.getRouting());
      } else if (summary.tone === 'error') {
        message.warning(summary.text);
      } else {
        message.info(summary.text);
      }
      await load();
    } catch (error) {
      message.error(getErrorMessage(error, '检测失败'));
    } finally {
      setChecking(false);
    }
  };

  const config = status?.config;
  const lastCheck = describeFailoverCheck(status?.lastCheck || null);
  const events = (status?.events || []).slice(0, RECENT_EVENT_COUNT);

  return (
    <div className="proxy-routing-section">
      <Title level={5} className="proxy-modal-section-title">默认出口自动切换</Title>
      <Space wrap align="center">
        <Switch
          aria-label="默认出口自动切换"
          checked={config?.enabled === true}
          loading={saving || !status}
          onChange={(enabled) => void save({ enabled })}
        />
        <Text>每</Text>
        <InputNumber
          aria-label="检测间隔（秒）"
          size="small"
          min={15}
          max={3600}
          step={15}
          value={config?.intervalSec}
          disabled={saving || !status}
          onBlur={(event) => commitNumber('intervalSec', event.target.value)}
          onPressEnter={(event) => commitNumber('intervalSec', (event.target as HTMLInputElement).value)}
        />
        <Text>秒检测一次，连续</Text>
        <InputNumber
          aria-label="失败阈值（次）"
          size="small"
          min={1}
          max={10}
          value={config?.failureThreshold}
          disabled={saving || !status}
          onBlur={(event) => commitNumber('failureThreshold', event.target.value)}
          onPressEnter={(event) => commitNumber('failureThreshold', (event.target as HTMLInputElement).value)}
        />
        <Text>次不通就换成最快的可用节点</Text>
      </Space>
      <Space wrap align="center" className="proxy-routing-status">
        <Tag color={lastCheck.tone} className="toolkit-status-tag">{lastCheck.text}</Tag>
        {status?.lastCheck && <Text type="secondary">{formatFailoverTime(status.lastCheck.at)}</Text>}
        <Button size="small" icon={<ReloadOutlined />} loading={checking} disabled={!dataPlaneReady} onClick={() => void checkNow()}>
          立即检测
        </Button>
      </Space>
      {events.length > 0 && (
        <Space direction="vertical" size={2} className="proxy-routing-status">
          <Text type="secondary">最近切换</Text>
          {events.map((event) => (
            <div key={`${event.at}-${event.to.nodeId}`}>
              <Text type="secondary">{formatFailoverTime(event.at)}</Text> <Text>{describeFailoverEvent(event)}</Text>
            </div>
          ))}
        </Space>
      )}
    </div>
  );
}
