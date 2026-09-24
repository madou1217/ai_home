import React, { useEffect, useState } from 'react';
import { Modal, Timeline, Tag, Spin, Empty, Typography, Space, Button } from 'antd';
import { HistoryOutlined, ReloadOutlined, ThunderboltOutlined, CheckCircleOutlined, ClockCircleOutlined, EyeOutlined } from '@ant-design/icons';
import type { Account } from '@/types';
import { accountsAPI } from '@/services/api';
import './account-overlays.css';

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
  classification: 'natural' | 'early_inferred' | 'plan_upgrade' | 'unknown';
  cause?: string;
  previousRemainingPct: number | null;
  currentRemainingPct: number | null;
  previousExpectedResetAtMs?: number | null;
  exhaustedAtMs?: number | null;
  occurredAtMs: number;
  detectedAtMs: number;
  earlyDurationMs?: number;
  previousPlanType?: string | null;
  currentPlanType?: string | null;
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

function formatPct(val: number | null | undefined): string {
  if (val === null || val === undefined || !Number.isFinite(Number(val))) return '未知';
  const rounded = Math.round(Number(val) * 100) / 100;
  return `${rounded}%`;
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
        <div className="quota-reset-history-scroll">
          {events.length === 0 ? (
            <Empty description="暂无配额重置记录" image={Empty.PRESENTED_IMAGE_SIMPLE} />
          ) : (
            <Timeline
              items={events.map((event) => {
                const isUpgrade = event.classification === 'plan_upgrade' || (event.cause && event.cause.startsWith('upgrade:'));
                const isEarly = !isUpgrade && (event.classification === 'early_inferred' || event.eventKind === 'replenishment');
                
                const tagColor = isUpgrade ? 'purple' : (isEarly ? 'blue' : 'green');
                const tagLabel = isUpgrade ? '套餐升级重置' : (isEarly ? '提前回血重置' : '自然周期重置');
                const icon = isUpgrade
                  ? <ThunderboltOutlined className="quota-reset-dot--upgrade" />
                  : (isEarly ? <ThunderboltOutlined className="quota-reset-dot--early" /> : <CheckCircleOutlined className="quota-reset-dot--natural" />);
                const resetTimeMs = event.occurredAtMs || event.detectedAtMs;

                return {
                  color: isEarly ? 'blue' : 'green',
                  dot: icon,
                  children: (
                    <div className="quota-reset-event">
                      <div className="quota-reset-event-head">
                        <Tag color={tagColor}>{tagLabel}</Tag>
                        {event.windowLabel ? <Tag>{event.windowLabel}</Tag> : null}
                        <span className="quota-reset-event-time">{formatTime(resetTimeMs)}</span>
                      </div>
                      <div className="quota-reset-event-delta">
                        <span className="hud-label">用量变化</span>
                        <span className="hud-display quota-reset-event-from">
                          {formatPct(event.previousRemainingPct)}
                        </span>
                        <span className="quota-reset-event-arrow" aria-hidden="true">➔</span>
                        <span className="hud-display quota-reset-event-to">
                          {formatPct(event.currentRemainingPct)}
                        </span>
                      </div>
                      {isUpgrade ? (
                        <div className="quota-reset-event-meta">
                          <Text type="secondary">
                            ✨ 账号套餐升级生效：{event.previousPlanType ? event.previousPlanType.toUpperCase() : 'FREE'} ➔ {event.currentPlanType ? event.currentPlanType.toUpperCase() : 'PRO'} (额度窗口重置回满)
                          </Text>
                        </div>
                      ) : null}
                      {event.exhaustedAtMs ? (
                        <div className="quota-reset-event-meta">
                          <Text type="secondary">
                            <ClockCircleOutlined />
                            耗尽时间点：<Text strong>{formatTime(event.exhaustedAtMs)}</Text>
                            {resetTimeMs > event.exhaustedAtMs ? (
                              <span> (耗尽后经历了 {formatDuration(resetTimeMs - event.exhaustedAtMs)} 恢复)</span>
                            ) : null}
                          </Text>
                        </div>
                      ) : null}
                      {!isEarly && event.detectedAtMs > resetTimeMs + 60000 ? (
                        <div className="quota-reset-event-meta">
                          <Text type="secondary">
                            <EyeOutlined />
                            系统观测同步于：{formatTime(event.detectedAtMs)}
                          </Text>
                        </div>
                      ) : null}
                      {isEarly && event.earlyDurationMs && event.earlyDurationMs > 0 && event.earlyDurationMs < 7 * 24 * 3600 * 1000 ? (
                        <div className="quota-reset-event-meta">
                          <Text type="secondary">
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
