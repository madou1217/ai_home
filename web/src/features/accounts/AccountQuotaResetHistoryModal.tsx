import React, { useEffect, useState } from 'react';
import { Modal, Timeline, Tag, Spin, Empty, Typography, Space, Button } from 'antd';
import { HistoryOutlined, ReloadOutlined, ThunderboltOutlined, CheckCircleOutlined } from '@ant-design/icons';
import type { Account } from '@/types';
import { accountsAPI } from '@/services/api';

const { Text } = Typography;

export interface QuotaResetEvent {
  id: number;
  eventKey: string;
  accountRef: string;
  provider: string;
  quotaKey: string;
  windowLabel?: string;
  windowMinutes?: number;
  eventKind: 'cycle_rollover' | 'replenishment';
  classification: 'natural' | 'early_inferred' | 'unknown';
  cause?: string;
  previousRemainingPct: number | null;
  currentRemainingPct: number | null;
  previousExpectedResetAtMs?: number | null;
  detectedAtMs: number;
  earlyDurationMs?: number;
}

interface AccountQuotaResetHistoryModalProps {
  account: Account | null;
  open: boolean;
  onClose: () => void;
}

function formatTime(timestampMs: number): string {
  if (!timestampMs) return '';
  const date = new Date(timestampMs);
  const Y = date.getFullYear();
  const M = String(date.getMonth() + 1).padStart(2, '0');
  const D = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const m = String(date.getMinutes()).padStart(2, '0');
  return `${Y}-${M}-${D} ${h}:${m}`;
}

function formatDuration(ms: number): string {
  if (!ms || ms <= 0) return '';
  const totalMinutes = Math.round(ms / 60000);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  const parts = [];
  if (days > 0) parts.push(`${days}天`);
  if (hours > 0) parts.push(`${hours}小时`);
  if (minutes > 0 && days === 0) parts.push(`${minutes}分钟`);
  return parts.join('') || '1分钟内';
}

export default function AccountQuotaResetHistoryModal({
  account,
  open,
  onClose
}: AccountQuotaResetHistoryModalProps) {
  const [loading, setLoading] = useState(false);
  const [events, setEvents] = useState<QuotaResetEvent[]>([]);

  const fetchEvents = async () => {
    if (!account) return;
    setLoading(true);
    try {
      const res = await accountsAPI.getQuotaResetEvents(account.provider, account.accountRef);
      if (res && res.ok && Array.isArray(res.events)) {
        setEvents(res.events);
      } else {
        setEvents([]);
      }
    } catch (_error) {
      setEvents([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open && account) {
      void fetchEvents();
    } else {
      setEvents([]);
    }
  }, [open, account?.provider, account?.accountRef]);

  const title = (
    <Space>
      <HistoryOutlined />
      <span>配额重置历史记录 - {account?.displayName || account?.email || account?.accountRef}</span>
    </Space>
  );

  return (
    <Modal
      title={title}
      open={open}
      onCancel={onClose}
      footer={[
        <Button key="refresh" icon={<ReloadOutlined />} onClick={fetchEvents} loading={loading}>
          刷新
        </Button>,
        <Button key="close" type="primary" onClick={onClose}>
          关闭
        </Button>
      ]}
      width={640}
      destroyOnClose
    >
      <Spin spinning={loading}>
        <div style={{ maxHeight: '60vh', overflowY: 'auto', padding: '16px 8px 8px 8px' }}>
          {events.length === 0 ? (
            <Empty description="暂无配额重置记录" image={Empty.PRESENTED_IMAGE_SIMPLE} />
          ) : (
            <Timeline
              items={events.map((event) => {
                const isEarly = event.classification === 'early_inferred' || event.eventKind === 'replenishment';
                const tagColor = isEarly ? 'blue' : 'green';
                const tagLabel = isEarly ? '提前回血重置' : '自然周期重置';
                const icon = isEarly ? <ThunderboltOutlined style={{ color: '#1677ff' }} /> : <CheckCircleOutlined style={{ color: '#52c41a' }} />;

                return {
                  color: isEarly ? 'blue' : 'green',
                  dot: icon,
                  children: (
                    <div style={{ marginBottom: 12 }}>
                      <Space orientation="horizontal" size="small" style={{ marginBottom: 4 }}>
                        <Tag color={tagColor}>{tagLabel}</Tag>
                        {event.windowLabel ? <Tag>{event.windowLabel}</Tag> : null}
                        <Text type="secondary">{formatTime(event.detectedAtMs)}</Text>
                      </Space>
                      <div>
                        <Text strong>用量变化：</Text>
                        <Text type="secondary">
                          {event.previousRemainingPct !== null ? `${event.previousRemainingPct}%` : '未知'}
                        </Text>
                        <Text strong style={{ margin: '0 6px', color: '#52c41a' }}>➔</Text>
                        <Text strong style={{ color: '#52c41a' }}>
                          {event.currentRemainingPct !== null ? `${event.currentRemainingPct}%` : '100%'}
                        </Text>
                      </div>
                      {isEarly && event.earlyDurationMs && event.earlyDurationMs > 0 ? (
                        <div style={{ marginTop: 2 }}>
                          <Text type="secondary" style={{ fontSize: 12 }}>
                            ⚡ 推断提前了约 <Text strong>{formatDuration(event.earlyDurationMs)}</Text> 回满
                          </Text>
                        </div>
                      ) : null}
                    </div>
                  )
                };
              })}
            />
          )}
        </div>
      </Spin>
    </Modal>
  );
}
