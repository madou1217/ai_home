import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Form, Input, Segmented, Space, Statistic, Tag, message } from 'antd';
import {
  ApiOutlined,
  DisconnectOutlined,
  LinkOutlined,
  PlayCircleOutlined,
  RadarChartOutlined,
  SendOutlined
} from '@ant-design/icons';
import PageHero from '@/components/ui/PageHero';
import './FabricWebrtcLab.css';

type LabRole = 'offerer' | 'answerer';
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

function getInitialRole(): LabRole {
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

export default function FabricWebrtcLab() {
  const peerId = useMemo(() => randomId('peer'), []);
  const [endpoint, setEndpoint] = useState(() => window.location.origin);
  const [role, setRole] = useState<LabRole>(getInitialRole);
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
  const roleRef = useRef<LabRole>(role);
  const autoStartKeyRef = useRef('');
  const candidateQueueRef = useRef<RTCIceCandidateInit[]>([]);
  const handledSignalSeqsRef = useRef<Set<number>>(new Set());
  const pendingPingsRef = useRef<Map<string, PendingPing>>(new Map());

  useEffect(() => {
    roleRef.current = role;
  }, [role]);

  const shareUrl = roomId
    ? `${window.location.origin}/ui/fabric/webrtc-lab?room=${encodeURIComponent(roomId)}&role=answerer`
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
      pending.reject(new Error('webrtc_lab_stopped'));
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

  const startPeer = useCallback(async (nextRole: LabRole, activeRoomId: string) => {
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
        setupDataChannel(pc.createDataChannel('aih-fabric-lab', { ordered: true }));
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
        body: JSON.stringify({ name: 'AIH Fabric WebRTC Lab' })
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

  return (
    <div className="fabric-webrtc-lab-page animate__animated animate__fadeIn animate__faster">
      <PageHero
        title="WebRTC DataChannel 实验"
        eyebrow="AIH Fabric Lab"
        description="短期信令房间只用于传输实验；默认工作流仍走已验证的 WSS fallback。跨 NAT 场景需要按实验记录配置 STUN/TURN。"
        actions={
          <Space size={8} wrap>
            <Tag color={channelState === 'open' ? 'green' : channelState === 'connecting' ? 'orange' : 'default'}>
              Channel: {channelState.toUpperCase()}
            </Tag>
            <Tag color={connectionState === 'connected' ? 'green' : 'default'}>
              Conn: {connectionState}
            </Tag>
            <Tag>ICE: {iceState}</Tag>
            <Tag>Gathering: {iceGatheringState}</Tag>
            <Tag>Signaling: {signalingState}</Tag>
          </Space>
        }
      />

      <div className="fabric-webrtc-lab-grid-workbench">
        <div className="fabric-webrtc-lab-left-column">
          {/* 信令房间面板 */}
          <section className="settings-panel">
            <div className="fabric-webrtc-lab-panel-head">
              <div>
                <h2>信令房间 (Signaling Room)</h2>
                <p>一端创建房间并开启 Offering，另一端使用分享 URL 作为 Answerer 加入。</p>
              </div>
              <ApiOutlined />
            </div>

            <Form layout="vertical">
              <Form.Item label="Signal Endpoint" style={{ marginBottom: 12 }}>
                <Input value={endpoint} onChange={(event) => setEndpoint(event.target.value)} />
              </Form.Item>
              <div className="fabric-webrtc-lab-row">
                <Form.Item label="Room ID" style={{ marginBottom: 12 }}>
                  <Input value={roomId} onChange={(event) => setRoomId(event.target.value.trim())} />
                </Form.Item>
                <Form.Item label="Role" style={{ marginBottom: 12 }}>
                  <Segmented
                    block
                    value={role}
                    onChange={(value) => setRole(value as LabRole)}
                    options={[
                      { label: 'Offer', value: 'offerer' },
                      { label: 'Answer', value: 'answerer' }
                    ]}
                  />
                </Form.Item>
              </div>
              <Form.Item label="ICE Servers" help="格式为 stun:host:port 或 turn:host:port，多条用换行隔开" style={{ marginBottom: 16 }}>
                <Input.TextArea
                  value={iceServersText}
                  onChange={(event) => setIceServersText(event.target.value)}
                  autoSize={{ minRows: 2, maxRows: 3 }}
                  placeholder="stun:host:port / turn:host:port"
                />
              </Form.Item>
              <Space wrap>
                <Button type="primary" icon={<PlayCircleOutlined />} loading={busy} onClick={createRoomAndStart}>
                  创建并连接
                </Button>
                <Button icon={<LinkOutlined />} loading={busy} disabled={!roomId} onClick={joinRoom}>
                  加入房间
                </Button>
                <Button icon={<DisconnectOutlined />} onClick={stopPeer}>
                  断开连接
                </Button>
              </Space>
            </Form>

            {shareUrl && (
              <div className="fabric-webrtc-lab-share-link">
                <Input
                  addonBefore="分享 URL"
                  value={shareUrl}
                  readOnly
                  suffix={
                    <Button type="link" size="small" onClick={copyShareUrl} style={{ padding: '0 4px' }}>
                      复制链接
                    </Button>
                  }
                />
              </div>
            )}

            {room && (
              <div className="fabric-webrtc-lab-room-meta">
                <Tag color="cyan">过期时间: {new Date(room.expiresAt).toLocaleTimeString()}</Tag>
                <Tag color="blue">{room.peerCount} Peers</Tag>
                <Tag color="purple">{room.messageCount} Signals</Tag>
              </div>
            )}
          </section>

          {/* RTT 打点采样与监控面板 */}
          <section className="settings-panel" style={{ marginTop: 16 }}>
            <div className="fabric-webrtc-lab-panel-head">
              <div>
                <h2>延迟打点与信令监控 (RTT & WebRTC Stats)</h2>
                <p>DataChannel 打点只统计应用层 ping/pong 传输延迟及 ICE 候选包统计。</p>
              </div>
              <RadarChartOutlined />
            </div>
            
            <div className="fabric-webrtc-lab-stats-section">
              <div className="fabric-webrtc-lab-stats-card-group">
                <div className="fabric-webrtc-lab-stats-card">
                  <Statistic title="采样数" value={rttSummary.count} />
                </div>
                <div className="fabric-webrtc-lab-stats-card">
                  <Statistic title="平均 RTT" value={rttSummary.avg} precision={2} suffix="ms" />
                </div>
                <div className="fabric-webrtc-lab-stats-card">
                  <Statistic title="P50 RTT" value={rttSummary.p50} precision={2} suffix="ms" />
                </div>
                <div className="fabric-webrtc-lab-stats-card">
                  <Statistic title="P95 RTT" value={rttSummary.p95} precision={2} suffix="ms" />
                </div>
              </div>

              <div className="fabric-webrtc-lab-stats-card-group fabric-webrtc-lab-stats-card-group--signals" style={{ marginTop: 12 }}>
                <div className="fabric-webrtc-lab-stats-card">
                  <Statistic title="本地 Candidate" value={localCandidateCount} />
                </div>
                <div className="fabric-webrtc-lab-stats-card">
                  <Statistic title="远端 Candidate" value={remoteCandidateCount} />
                </div>
                <div className="fabric-webrtc-lab-stats-card">
                  <Statistic title="信令交互数" value={receivedSignalCount} />
                </div>
                <div className="fabric-webrtc-lab-stats-card">
                  <Statistic title="队列积压" value={candidateQueueRef.current.length} />
                </div>
              </div>
            </div>

            <Space wrap style={{ marginTop: 16 }}>
              <Button type="primary" icon={<SendOutlined />} disabled={channelState !== 'open'} onClick={runPing}>
                Ping 测试
              </Button>
              <Button disabled={channelState !== 'open'} onClick={runBenchmark}>
                5 次采样基准测试
              </Button>
            </Space>
          </section>
        </div>

        {/* 右侧一栏：事件日志 */}
        <div className="fabric-webrtc-lab-right-column">
          <section className="settings-panel fabric-webrtc-lab-log-panel">
            <div className="fabric-webrtc-lab-panel-head">
              <div>
                <h2>诊断事件日志</h2>
                <p>实时记录信令握手与连接协商事件，仅保留最近 80 条。</p>
              </div>
            </div>
            <div style={{ marginBottom: 12 }}>
              <span style={{ fontSize: 12, color: 'var(--app-muted)' }}>当前 Peer ID: </span>
              <code style={{ fontSize: 11, background: 'var(--app-surface-muted)', padding: '2px 6px', borderRadius: 4 }}>{peerId}</code>
            </div>
            <div className="fabric-webrtc-lab-console-log">
              {logs.length === 0 ? (
                <div className="fabric-webrtc-lab-console-empty">暂无事件记录</div>
              ) : (
                logs.map((line, index) => {
                  const match = line.match(/^(\d{2}:\d{2}:\d{2})\s(.*)$/);
                  if (match) {
                    return (
                      <div className="console-line" key={index}>
                        <span className="console-time">{match[1]}</span>
                        <span className="console-text">{match[2]}</span>
                      </div>
                    );
                  }
                  return <div className="console-line" key={index}>{line}</div>;
                })
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
