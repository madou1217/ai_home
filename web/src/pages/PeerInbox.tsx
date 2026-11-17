import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Segmented, Space, Table, Tag, Tooltip, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import PageScaffold from '@/components/ui/PageScaffold';
import SectionCard from '@/components/ui/SectionCard';
import InlineNote from '@/components/ui/InlineNote';
import HudStateView from '@/components/hud/HudStateView';
import { resolveOrderedDirection, useSurfaceSwitch } from '@/hooks/use-surface-switch';
import api, { watchPeerMessages } from '@/services/api';
import './PeerInbox.css';

type PeerParty = {
  channel: string;
  provider: string;
  name: string;
  address: string;
  sessionId: string;
};

type PeerMessage = {
  id: string;
  shortId: string;
  from: PeerParty;
  to: PeerParty;
  replyTo: string;
  replyToShort: string;
  body: string;
  state: string;
  createdAt: number;
  deliveredAt: number;
  readAt: number;
  nextAttemptAt: number;
  attemptCount: number;
  error: string;
  lastAttemptError: string;
};

type PeerCounts = {
  total: number;
  pending: number;
  delivered: number;
  read: number;
  failed: number;
};

const STATE_META: Record<string, { color: string; label: string }> = {
  pending: { color: 'gold', label: '待投递' },
  delivered: { color: 'blue', label: '已送达' },
  read: { color: 'green', label: '已读' },
  failed: { color: 'red', label: '投递失败' }
};

const FILTER_OPTIONS = [
  { label: '全部', value: 'all' },
  { label: '待投递', value: 'pending' },
  { label: '已送达', value: 'delivered' },
  { label: '已读', value: 'read' },
  { label: '失败', value: 'failed' }
];

function formatTime(ms: number) {
  if (!ms) return '-';
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function partyLabel(party: PeerParty) {
  const name = party.name || party.address || party.sessionId || '-';
  const provider = party.provider ? `${party.provider} · ` : '';
  return `${provider}${name}`;
}

const PeerInbox: React.FC = () => {
  const [messages, setMessages] = useState<PeerMessage[]>([]);
  const [counts, setCounts] = useState<PeerCounts | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('all');
  const { surfaceRef: inboxSurfaceRef, switchSurface: switchInboxSurface } = useSurfaceSwitch<HTMLDivElement>();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await api.get('/webui/peer/messages');
      const payload = response.data || {};
      setMessages(Array.isArray(payload.messages) ? payload.messages : []);
      setCounts(payload.counts || null);
      setError('');
    } catch (requestError: any) {
      setError(requestError?.response?.data?.error || requestError?.message || '读取失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    return undefined;
  }, [load]);

  // 收件箱目录变化由服务端 fs.watch 推 SSE；页面不再周期轮询。
  useEffect(() => {
    const source = watchPeerMessages();
    source.onmessage = () => { void load(); };
    return () => source.close();
  }, [load]);

  const visible = useMemo(() => (
    filter === 'all' ? messages : messages.filter((message) => message.state === filter)
  ), [messages, filter]);

  const columns = [
    {
      title: '时间',
      dataIndex: 'createdAt',
      width: 140,
      render: (value: number) => <span className="peer-inbox-time">{formatTime(value)}</span>
    },
    {
      title: '状态',
      dataIndex: 'state',
      width: 96,
      render: (state: string) => {
        const meta = STATE_META[state] || { color: 'default', label: state };
        return <Tag color={meta.color}>{meta.label}</Tag>;
      }
    },
    {
      title: '从',
      dataIndex: 'from',
      width: 220,
      render: (party: PeerParty) => <span className="peer-inbox-party">{partyLabel(party)}</span>
    },
    {
      title: '到',
      dataIndex: 'to',
      width: 220,
      render: (party: PeerParty) => <span className="peer-inbox-party">{partyLabel(party)}</span>
    },
    {
      title: '正文',
      dataIndex: 'body',
      render: (body: string) => (
        <Typography.Paragraph className="peer-inbox-body" ellipsis={{ rows: 2, tooltip: body }}>
          {body}
        </Typography.Paragraph>
      )
    },
    {
      title: '回复',
      dataIndex: 'replyToShort',
      width: 100,
      render: (value: string) => (value ? <span className="peer-inbox-id">#{value}</span> : '-')
    },
    {
      title: '尝试',
      dataIndex: 'attemptCount',
      width: 70,
      render: (value: number) => value || '-'
    }
  ];

  return (
    <PageScaffold
      ghost
      code="INBOX"
      className="peer-inbox-page"
      title="消息收件箱"
      subTitle="实时监听跨会话 aih peer 消息队列、投递状态与原始载荷。"
      extra={(
        <Button type="primary" icon={<ReloadOutlined />} onClick={load} loading={loading}>
          刷新
        </Button>
      )}
    >
      <SectionCard
        title="Peer 投递队列"
        extra={counts ? (
          <Space size={4} wrap>
            <Tag>共 {counts.total}</Tag>
            <Tag color="gold">待投递 {counts.pending}</Tag>
            <Tag color="blue">已送达 {counts.delivered}</Tag>
            <Tag color="green">已读 {counts.read}</Tag>
            <Tag color="red">失败 {counts.failed}</Tag>
          </Space>
        ) : null}
      >
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <div className="peer-inbox-toolbar">
            <Segmented
              options={FILTER_OPTIONS}
              value={filter}
              onChange={(value) => {
                const next = String(value);
                const order = FILTER_OPTIONS.map((item) => item.value);
                switchInboxSurface(() => setFilter(next), {
                  current: filter,
                  next,
                  direction: resolveOrderedDirection(order, filter, next)
                });
              }}
            />
          </div>

          {error ? (
            <InlineNote tone="error" description={error}>
              收件箱读取失败
            </InlineNote>
          ) : null}

          <div ref={inboxSurfaceRef}>
            <Table
              rowKey="id"
              size="small"
              loading={loading}
              dataSource={visible}
              columns={columns as any}
              pagination={{ pageSize: 20, hideOnSinglePage: true }}
              locale={{
                emptyText: (
                  <HudStateView
                    compact
                    code="NO_PEER_MSG"
                    title="还没有 peer 消息"
                    description="由 aih peer send 派发的跨会话协作消息会自动实时推送至此。"
                  />
                )
              }}
              expandable={{
                expandedRowRender: (message: PeerMessage) => (
                  <div className="peer-inbox-detail">
                    <div><span className="peer-inbox-detail-label">消息 ID</span><span className="peer-inbox-id">{message.id}</span></div>
                    <div><span className="peer-inbox-detail-label">从</span>{partyLabel(message.from)}{message.from.sessionId ? ` · ${message.from.sessionId}` : ''}</div>
                    <div><span className="peer-inbox-detail-label">到</span>{partyLabel(message.to)}{message.to.sessionId ? ` · ${message.to.sessionId}` : ''}</div>
                    <div><span className="peer-inbox-detail-label">回复</span>{message.replyTo ? `#${message.replyToShort}` : '-'}</div>
                    <div><span className="peer-inbox-detail-label">送达</span>{formatTime(message.deliveredAt)}</div>
                    <div><span className="peer-inbox-detail-label">已读</span>{formatTime(message.readAt)}</div>
                    <div><span className="peer-inbox-detail-label">下次重试</span>{formatTime(message.nextAttemptAt)}</div>
                    {(message.error || message.lastAttemptError) && (
                      <div><span className="peer-inbox-detail-label">最近错误</span><span className="peer-inbox-error">{message.error || message.lastAttemptError}</span></div>
                    )}
                    <Tooltip title="原始正文">
                      <pre className="peer-inbox-raw">{message.body}</pre>
                    </Tooltip>
                  </div>
                )
              }}
            />
          </div>
        </Space>
      </SectionCard>
    </PageScaffold>
  );
};

export default PeerInbox;
