import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StatisticCard } from '@ant-design/pro-components';
import { Col, Descriptions, Form, Input, List, Row, Segmented, Space, Tag, Typography, message } from 'antd';
import {
  DisconnectOutlined,
  LinkOutlined,
  PlayCircleOutlined,
  SendOutlined,
  DeleteOutlined
} from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import PageScaffold from '@/components/ui/PageScaffold';
import SectionCard from '@/components/ui/SectionCard';

type DiagnosticRole = 'offerer' | 'answerer';
type SignalType = 'offer' | 'answer' | 'candidate' | 'ready' | 'meta';

interface SignalRoom {
  roomId: string;
  createdAt: number;
  expiresAt: number;
  messageCount: number;
  peerCount: number;
}

interface SignalMessage {
  seq: number;
  peerId: string;
  type: SignalType;
  payload: Record<string, unknown>;
  createdAt: number;
}

interface PendingPing {
  sentAt: number;
  resolve: (rtt: number) => void;
  reject: (error: Error) => void;
  timer: number;
}

function randomId(prefix: string) {
  const bytes = new Uint8Array(8);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  }
  return `${prefix}-${Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function normalizeEndpoint(value: string) {
  return String(value || '').trim().replace(/\/+$/, '') || window.location.origin;
}

function getInitialRole(): DiagnosticRole {
  const role = new URLSearchParams(window.location.search).get('role');
  return role === 'answerer' ? 'answerer' : 'offerer';
}

function getInitialRoomId() {
  return new URLSearchParams(window.location.search).get('room') || '';
}

function parseIceServers(value: string): RTCIceServer[] {
  return String(value || '')
    .split(/[\n,]+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((url) => ({ urls: url }));
}

function describeRtt(samples: number[]) {
  const values = samples.slice().sort((left, right) => left - right);
  if (values.length === 0) return { count: 0, avg: 0, p50: 0, p95: 0 };
  const sum = values.reduce((total, value) => total + value, 0);
  const percentile = (rank: number) => values[Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * rank) - 1))];
  return {
    count: values.length,
    avg: Math.round((sum / values.length) * 100) / 100,
    p50: percentile(0.50),
    p95: percentile(0.95)
  };
}

async function readJson<T>(response: Response): Promise<T> {
  const payload = await response.json();
  if (!response.ok || !payload?.ok) {
    throw new Error(String(payload?.error || `http_${response.status}`));
  }
  return payload.result as T;
}

export default function FabricWebrtcDiagnostics() {
  const peerId = useMemo(() => randomId('peer'), []);
  const [endpoint, setEndpoint] = useState(() => window.location.origin);
  const [role, setRole] = useState<DiagnosticRole>(getInitialRole);
  const [roomId, setRoomId] = useState(getInitialRoomId);
  const [room, setRoom] = useState<SignalRoom | null>(null);
  const [iceServersText, setIceServersText] = useState('');
  const [connectionState, setConnectionState] = useState('idle');
  const [iceState, setIceState] = useState('idle');
  const [iceGatheringState, setIceGatheringState] = useState('idle');
  const [signalingState, setSignalingState] = useState('idle');
  const [channelState, setChannelState] = useState('closed');
  const [localCandidateCount, setLocalCandidateCount] = useState(0);
  const [remoteCandidateCount, setRemoteCandidateCount] = useState(0);
  const [receivedSignalCount, setReceivedSignalCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [rtts, setRtts] = useState<number[]>([]);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const channelRef = useRef<RTCDataChannel | null>(null);
  const pollTimerRef = useRef<number | null>(null);
  const pollInFlightRef = useRef(false);
  const lastSeqRef = useRef(0);
  const roleRef = useRef<DiagnosticRole>(role);
  const autoStartKeyRef = useRef('');
  const candidateQueueRef = useRef<RTCIceCandidateInit[]>([]);
  const handledSignalSeqsRef = useRef<Set<number>>(new Set());
  const pendingPingsRef = useRef<Map<string, PendingPing>>(new Map());

  useEffect(() => {
    roleRef.current = role;
  }, [role]);

  const shareUrl = roomId
    ? `${window.location.origin}/ui/fabric/webrtc-diagnostics?room=${encodeURIComponent(roomId)}&role=answerer`
    : '';
  const rttSummary = describeRtt(rtts);

  const addLog = useCallback((line: string) => {
    const stamp = new Date().toLocaleTimeString();
    setLogs((current) => [`${stamp} ${line}`, ...current].slice(0, 80));
  }, []);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current !== null) {
      window.clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const stopPeer = useCallback(() => {
    stopPolling();
    pendingPingsRef.current.forEach((pending) => {
      window.clearTimeout(pending.timer);
      pending.reject(new Error('webrtc_diagnostics_stopped'));
    });
    pendingPingsRef.current.clear();
    candidateQueueRef.current = [];
    channelRef.current?.close();
    pcRef.current?.close();
    channelRef.current = null;
    pcRef.current = null;
    pollInFlightRef.current = false;
    lastSeqRef.current = 0;
    handledSignalSeqsRef.current.clear();
    setConnectionState('closed');
    setIceState('closed');
    setIceGatheringState('closed');
    setSignalingState('closed');
    setChannelState('closed');
    setLocalCandidateCount(0);
    setRemoteCandidateCount(0);
    setReceivedSignalCount(0);
  }, [stopPolling]);

  useEffect(() => () => stopPeer(), [stopPeer]);

  const apiUrl = useCallback((path: string) => `${normalizeEndpoint(endpoint)}${path}`, [endpoint]);

  const sendSignal = useCallback(async (nextRoomId: string, type: SignalType, payload: Record<string, unknown>) => {
    const response = await fetch(apiUrl(`/v0/fabric/webrtc/signaling/rooms/${encodeURIComponent(nextRoomId)}/messages`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ peerId, type, payload })
    });
    const result = await readJson<SignalMessage>(response);
    return result;
  }, [apiUrl, peerId]);

  const flushCandidates = useCallback(async () => {
    const pc = pcRef.current;
    if (!pc || !pc.remoteDescription) return;
    const queued = candidateQueueRef.current.splice(0);
    for (const candidate of queued) {
      await pc.addIceCandidate(candidate)
        .then(() => addLog('queued candidate added'))
        .catch((error) => addLog(`candidate failed: ${String(error?.message || error)}`));
    }
  }, [addLog]);

  const setupDataChannel = useCallback((channel: RTCDataChannel) => {
    channelRef.current = channel;
    setChannelState(channel.readyState);
    channel.onopen = () => {
      setChannelState(channel.readyState);
      addLog('data channel open');
    };
    channel.onclose = () => {
      setChannelState(channel.readyState);
      addLog('data channel closed');
    };
    channel.onerror = () => addLog('data channel error');
    channel.onmessage = (event) => {
      let payload: { kind?: string; id?: string; sentAt?: number } = {};
      try {
        payload = JSON.parse(String(event.data || '{}'));
      } catch (_error) {
        addLog('received non-json data');
        return;
      }
      if (payload.kind === 'ping' && payload.id) {
        channel.send(JSON.stringify({ kind: 'pong', id: payload.id, sentAt: payload.sentAt }));
        return;
      }
      if (payload.kind === 'pong' && payload.id) {
        const pending = pendingPingsRef.current.get(payload.id);
        if (!pending) return;
        pendingPingsRef.current.delete(payload.id);
        window.clearTimeout(pending.timer);
        const rtt = Math.max(0, Math.round((performance.now() - pending.sentAt) * 100) / 100);
        setRtts((current) => [...current, rtt].slice(-100));
        pending.resolve(rtt);
      }
    };
  }, [addLog]);

  const handleRemoteSignal = useCallback(async (messageItem: SignalMessage, activeRoomId: string) => {
    if (messageItem.peerId === peerId) return;
    const pc = pcRef.current;
    if (!pc) return;
    if (handledSignalSeqsRef.current.has(messageItem.seq)) return;
    handledSignalSeqsRef.current.add(messageItem.seq);
    setReceivedSignalCount((current) => current + 1);
    if (messageItem.type === 'offer' && roleRef.current === 'answerer') {
      const sdp = String(messageItem.payload.sdp || '');
      if (!sdp || pc.remoteDescription || pc.signalingState !== 'stable') return;
      addLog('offer received');
      await pc.setRemoteDescription({ type: 'offer', sdp });
      await flushCandidates();
      if ((pc.signalingState as RTCSignalingState) !== 'have-remote-offer') return;
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await sendSignal(activeRoomId, 'answer', {
        type: pc.localDescription?.type || 'answer',
        sdp: pc.localDescription?.sdp || ''
      });
      addLog('answer sent');
      return;
    }
    if (messageItem.type === 'answer' && roleRef.current === 'offerer') {
      const sdp = String(messageItem.payload.sdp || '');
      if (!sdp || pc.remoteDescription || pc.signalingState !== 'have-local-offer') return;
      addLog('answer received');
      await pc.setRemoteDescription({ type: 'answer', sdp });
      await flushCandidates();
      return;
    }
    if (messageItem.type === 'candidate') {
      const candidate = messageItem.payload.candidate as RTCIceCandidateInit | undefined;
      if (!candidate) return;
      setRemoteCandidateCount((current) => current + 1);
      if (!pc.remoteDescription) {
        candidateQueueRef.current.push(candidate);
        addLog('candidate queued');
        return;
      }
      await pc.addIceCandidate(candidate)
        .then(() => addLog('candidate added'))
        .catch((error) => addLog(`candidate failed: ${String(error?.message || error)}`));
    }
  }, [addLog, flushCandidates, peerId, sendSignal]);

  const pollSignals = useCallback(async (activeRoomId: string) => {
    if (pollInFlightRef.current) return;
    pollInFlightRef.current = true;
    try {
      const since = lastSeqRef.current;
      const response = await fetch(apiUrl(`/v0/fabric/webrtc/signaling/rooms/${encodeURIComponent(activeRoomId)}/messages?since=${since}&limit=100`));
      const result = await readJson<{ messages: SignalMessage[]; nextSeq: number }>(response);
      for (const item of result.messages || []) {
        try {
          await handleRemoteSignal(item, activeRoomId);
        } catch (error) {
          addLog(`signal ${item.seq} failed: ${String(error instanceof Error ? error.message : error)}`);
        } finally {
          lastSeqRef.current = Math.max(lastSeqRef.current, Number(item.seq) || since);
        }
      }
      lastSeqRef.current = Math.max(lastSeqRef.current, Number(result.nextSeq) || since);
    } finally {
      pollInFlightRef.current = false;
    }
  }, [addLog, apiUrl, handleRemoteSignal]);

  const startPolling = useCallback((activeRoomId: string) => {
    stopPolling();
    pollTimerRef.current = window.setInterval(() => {
      pollSignals(activeRoomId).catch((error) => addLog(`signal poll failed: ${String(error?.message || error)}`));
    }, 700);
  }, [addLog, pollSignals, stopPolling]);

  const startPeer = useCallback(async (nextRole: DiagnosticRole, activeRoomId: string) => {
    if (!activeRoomId) throw new Error('missing_webrtc_room');
    stopPeer();
    setBusy(true);
    setRole(nextRole);
    setRoomId(activeRoomId);
    setRtts([]);
    try {
      const pc = new RTCPeerConnection({ iceServers: parseIceServers(iceServersText) });
      pcRef.current = pc;
      roleRef.current = nextRole;
      setConnectionState(pc.connectionState);
      setIceState(pc.iceConnectionState);
      setIceGatheringState(pc.iceGatheringState);
      setSignalingState(pc.signalingState);
      setLocalCandidateCount(0);
      setRemoteCandidateCount(0);
      setReceivedSignalCount(0);
      pc.onconnectionstatechange = () => {
        setConnectionState(pc.connectionState);
        addLog(`connection ${pc.connectionState}`);
      };
      pc.oniceconnectionstatechange = () => {
        setIceState(pc.iceConnectionState);
        addLog(`ice ${pc.iceConnectionState}`);
      };
      pc.onicegatheringstatechange = () => {
        setIceGatheringState(pc.iceGatheringState);
        addLog(`ice gathering ${pc.iceGatheringState}`);
      };
      pc.onsignalingstatechange = () => {
        setSignalingState(pc.signalingState);
        addLog(`signaling ${pc.signalingState}`);
      };
      pc.onicecandidate = (event) => {
        if (!event.candidate) {
          addLog('candidate gathering complete');
          return;
        }
        setLocalCandidateCount((current) => current + 1);
        sendSignal(activeRoomId, 'candidate', { candidate: event.candidate.toJSON() })
          .catch((error) => addLog(`candidate send failed: ${String(error?.message || error)}`));
      };
      pc.ondatachannel = (event) => setupDataChannel(event.channel);
      startPolling(activeRoomId);

      if (nextRole === 'offerer') {
        setupDataChannel(pc.createDataChannel('aih-fabric-diagnostics', { ordered: true }));
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await sendSignal(activeRoomId, 'offer', {
          type: pc.localDescription?.type || 'offer',
          sdp: pc.localDescription?.sdp || ''
        });
        addLog('offer sent');
      } else {
        await sendSignal(activeRoomId, 'ready', { role: nextRole });
        addLog('waiting for offer');
      }
      window.setTimeout(() => {
        if (channelRef.current?.readyState !== 'open' && pcRef.current === pc) {
          addLog(`still not open: connection=${pc.connectionState}, ice=${pc.iceConnectionState}, gathering=${pc.iceGatheringState}`);
        }
      }, 10000);
    } finally {
      setBusy(false);
    }
  }, [addLog, iceServersText, sendSignal, setupDataChannel, startPolling, stopPeer]);

  useEffect(() => {
    if (!roomId || role !== 'answerer' || pcRef.current) return;
    const key = `${role}:${roomId}`;
    if (autoStartKeyRef.current === key) return;
    const timer = window.setTimeout(() => {
      if (autoStartKeyRef.current === key || pcRef.current) return;
      autoStartKeyRef.current = key;
      startPeer('answerer', roomId).catch((error) => {
        autoStartKeyRef.current = '';
        message.error(String(error instanceof Error ? error.message : error));
      });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [role, roomId, startPeer]);

  const createRoomAndStart = async () => {
    setBusy(true);
    try {
      const response = await fetch(apiUrl('/v0/fabric/webrtc/signaling/rooms'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'AIH Fabric WebRTC Diagnostics' })
      });
      const nextRoom = await readJson<SignalRoom>(response);
      setRoom(nextRoom);
      await startPeer('offerer', nextRoom.roomId);
      addLog(`room created ${nextRoom.roomId}`);
    } catch (error) {
      message.error(String(error instanceof Error ? error.message : error));
    } finally {
      setBusy(false);
    }
  };

  const joinRoom = async () => {
    try {
      await startPeer(role, roomId);
    } catch (error) {
      message.error(String(error instanceof Error ? error.message : error));
    }
  };

  const sendPing = useCallback(() => {
    const channel = channelRef.current;
    if (!channel || channel.readyState !== 'open') {
      return Promise.reject(new Error('data_channel_not_open'));
    }
    const id = randomId('ping');
    const sentAt = performance.now();
    const promise = new Promise<number>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        pendingPingsRef.current.delete(id);
        reject(new Error('ping_timeout'));
      }, 5000);
      pendingPingsRef.current.set(id, { sentAt, resolve, reject, timer });
    });
    channel.send(JSON.stringify({ kind: 'ping', id, sentAt }));
    return promise;
  }, []);

  const runPing = async () => {
    try {
      const rtt = await sendPing();
      addLog(`ping rtt ${rtt}ms`);
    } catch (error) {
      message.error(String(error instanceof Error ? error.message : error));
    }
  };

  const runBenchmark = async () => {
    try {
      for (let index = 0; index < 5; index += 1) {
        const rtt = await sendPing();
        addLog(`bench ${index + 1}/5 ${rtt}ms`);
        await new Promise((resolve) => window.setTimeout(resolve, 180));
      }
    } catch (error) {
      message.error(String(error instanceof Error ? error.message : error));
    }
  };

  const copyShareUrl = async () => {
    if (!shareUrl) return;
    await navigator.clipboard?.writeText(shareUrl);
    message.success('已复制');
  };

  const connectionTag = channelState === 'open' ? (
    <Tag color="green">已连接 (OPEN)</Tag>
  ) : channelState === 'connecting' ? (
    <Tag color="orange">连接中</Tag>
  ) : (
    <Tag color="default">未连接</Tag>
  );

  return (
    <PageScaffold ghost
      title="WebRTC DataChannel 诊断"
      subTitle="用于验证 WebRTC 候选传输的真实连接、ICE 状态、DataChannel 和 RTT；未通过 promotion gate 前默认工作流仍走 WSS fallback。"
      extra={
        <Space size={8} wrap>
          <Button type="primary" icon={<PlayCircleOutlined />} loading={busy} onClick={createRoomAndStart}>
            创建并连接
          </Button>
          <Button icon={<LinkOutlined />} loading={busy} disabled={!roomId} onClick={joinRoom}>
            加入房间
          </Button>
          <Button icon={<DisconnectOutlined />} danger disabled={channelState === 'closed'} onClick={stopPeer}>
            断开连接
          </Button>
        </Space>
      }
    >
      <StatisticCard.Group direction="row" style={{ marginBottom: 16 }}>
        <StatisticCard statistic={{ title: '连接状态', value: String(connectionState || 'idle').toUpperCase(), prefix: connectionTag }} />
        <StatisticCard statistic={{ title: 'ICE 状态 / 收集', value: `${iceState} / ${iceGatheringState}` }} />
        <StatisticCard statistic={{ title: '数据通道', value: channelState }} />
        <StatisticCard statistic={{ title: 'Candidate 本 / 远', value: `${localCandidateCount} / ${remoteCandidateCount}` }} />
        <StatisticCard statistic={{ title: '信号交互 / 积压', value: `${receivedSignalCount} / ${candidateQueueRef.current.length}` }} />
        <StatisticCard statistic={{ title: '平均 / P50 / P95', value: `${rttSummary.avg} / ${rttSummary.p50} / ${rttSummary.p95} ms` }} />
      </StatisticCard.Group>

      <SectionCard title="信令房间配置">
        <Form layout="vertical">
          <Form.Item label="Signal Endpoint" style={{ marginBottom: 12 }}>
            <Input value={endpoint} onChange={(event) => setEndpoint(event.target.value)} />
          </Form.Item>
          <Row gutter={16}>
            <Col xs={24} sm={14}>
              <Form.Item label="Room ID" style={{ marginBottom: 12 }}>
                <Input value={roomId} onChange={(event) => setRoomId(event.target.value.trim())} />
              </Form.Item>
            </Col>
            <Col xs={24} sm={10}>
              <Form.Item label="Role" style={{ marginBottom: 12 }}>
                <Segmented
                  block
                  value={role}
                  onChange={(value) => setRole(value as DiagnosticRole)}
                  options={[
                    { label: 'Offer', value: 'offerer' },
                    { label: 'Answer', value: 'answerer' }
                  ]}
                />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item label="ICE Servers" help="格式为 stun:host:port 或 turn:host:port，多条用换行隔开" style={{ marginBottom: 16 }}>
            <Input.TextArea
              value={iceServersText}
              onChange={(event) => setIceServersText(event.target.value)}
              autoSize={{ minRows: 2, maxRows: 3 }}
              placeholder="stun:host:port / turn:host:port"
            />
          </Form.Item>
        </Form>

        {shareUrl && (
          <Input
            style={{ marginTop: 16 }}
            addonBefore="分享链接"
            value={shareUrl}
            readOnly
            suffix={
              <Button type="link" size="small" onClick={copyShareUrl} style={{ padding: '0 4px' }}>
                复制链接
              </Button>
            }
          />
        )}

        {room && (
          <Space wrap style={{ marginTop: 12 }}>
            <Tag color="cyan">过期时间: {new Date(room.expiresAt).toLocaleTimeString()}</Tag>
            <Tag color="blue">{room.peerCount} Peers</Tag>
            <Tag color="purple">{room.messageCount} Signals</Tag>
          </Space>
        )}
      </SectionCard>

      <SectionCard
        title="测试与性能打点"
        extra={
          <Space wrap>
            <Button type="primary" icon={<SendOutlined />} disabled={channelState !== 'open'} onClick={runPing}>
              Ping 测试
            </Button>
            <Button disabled={channelState !== 'open'} onClick={runBenchmark}>
              5次采样基准测试
            </Button>
          </Space>
        }
      >
        <Descriptions size="small" column={{ xs: 1, sm: 2, md: 4 }}>
          <Descriptions.Item label="RTT 采样数">{rttSummary.count}</Descriptions.Item>
          <Descriptions.Item label="平均 RTT">{rttSummary.avg} ms</Descriptions.Item>
          <Descriptions.Item label="P50 RTT">{rttSummary.p50} ms</Descriptions.Item>
          <Descriptions.Item label="P95 RTT">{rttSummary.p95} ms</Descriptions.Item>
        </Descriptions>
      </SectionCard>

      <SectionCard
        title="诊断事件日志"
        extra={
          <Space>
            <span style={{ fontSize: 12, color: 'var(--app-muted)' }}>Peer ID: </span>
            <code style={{ fontSize: 11, background: 'var(--app-surface-muted)', padding: '2px 6px', borderRadius: 4, marginRight: 8 }}>{peerId}</code>
            <Button
              size="small"
              icon={<DeleteOutlined />}
              onClick={() => setLogs([])}
              disabled={logs.length === 0}
            >
              清空日志
            </Button>
          </Space>
        }
      >
        <List
          size="small"
          bordered
          dataSource={logs}
          locale={{ emptyText: '暂无数据' }}
          style={{ maxHeight: 240, overflowY: 'auto', fontFamily: 'var(--font-mono)', fontSize: 12 }}
          renderItem={(line) => {
            const match = line.match(/^(\d{2}:\d{2}:\d{2})\s(.*)$/);
            return (
              <List.Item style={{ padding: '4px 12px', borderBlockEnd: 'none' }}>
                {match ? (
                  <Space size={8} align="start" style={{ width: '100%', wordBreak: 'break-all' }}>
                    <Typography.Text type="success" style={{ fontFamily: 'var(--font-mono)', fontSize: 12, flex: '0 0 auto' }}>
                      {match[1]}
                    </Typography.Text>
                    <Typography.Text style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                      {match[2]}
                    </Typography.Text>
                  </Space>
                ) : (
                  <Typography.Text style={{ fontFamily: 'var(--font-mono)', fontSize: 12, wordBreak: 'break-all' }}>
                    {line}
                  </Typography.Text>
                )}
              </List.Item>
            );
          }}
        />
      </SectionCard>
    </PageScaffold>
  );
}
