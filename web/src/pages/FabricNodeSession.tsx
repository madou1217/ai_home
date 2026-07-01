import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Input, Select, Space, Typography } from 'antd';
import Button from '@/components/ui/AppButton';
import type { ControlPlaneProfile } from '@/types';
import type { FabricRegistryProject } from '@/services/fabric-registry';
import {
  fetchControlPlaneDeviceNodeSessionRunEvents,
  startControlPlaneDeviceNodeSession
} from '@/services/control-plane-profiles';

/* 节点内嵌会话面板：走已验证的设备 token 路（start + 轮询 run-events）。
 * 真实连接、真实回复，不做任何 mock。 */

interface ChatMessage {
  role: 'user' | 'ai';
  text: string;
}

type Phase = 'idle' | 'starting' | 'streaming' | 'error';

const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 90000;

function providerName(provider: string) {
  const key = String(provider || '').toLowerCase();
  const map: Record<string, string> = { codex: 'Codex', claude: 'Claude', agy: 'AGY', opencode: 'OpenCode' };
  return map[key] || provider;
}

export default function FabricNodeSession({ profile, nodeId, provider, projects }: {
  profile: Pick<ControlPlaneProfile, 'endpoint' | 'deviceToken'>;
  nodeId: string;
  provider: string;
  projects: FabricRegistryProject[];
}) {
  const projectOptions = useMemo(
    () => projects.map((project) => ({
      value: project.displayPath,
      label: project.name || project.displayPath || project.id
    })).filter((option) => option.value),
    [projects]
  );

  const [projectPath, setProjectPath] = useState(projectOptions[0]?.value || '');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [errorText, setErrorText] = useState('');
  const sessionIdRef = useRef('');
  const mountedRef = useRef(true);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // 切换节点/provider 时重置会话
  useEffect(() => {
    sessionIdRef.current = '';
    setMessages([]);
    setPhase('idle');
    setErrorText('');
  }, [nodeId, provider]);

  useEffect(() => {
    if (!projectPath && projectOptions[0]?.value) setProjectPath(projectOptions[0].value);
  }, [projectOptions, projectPath]);

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [messages, phase]);

  const busy = phase === 'starting' || phase === 'streaming';

  const send = useCallback(async () => {
    const prompt = input.trim();
    if (!prompt || busy) return;
    if (!projectPath) { setErrorText('这台机器还没有可打开的项目，无法发起会话。'); return; }
    if (!profile.deviceToken) { setErrorText('当前 server profile 未配对（缺少设备令牌）。'); return; }

    setErrorText('');
    setInput('');
    setMessages((prev) => [...prev, { role: 'user', text: prompt }]);
    setPhase('starting');

    try {
      const started = await startControlPlaneDeviceNodeSession(profile, {
        nodeId,
        provider,
        projectPath,
        prompt,
        sessionId: sessionIdRef.current || undefined
      });
      if (!started.accepted || !started.runId) {
        throw new Error(started.status ? `会话未被接受（${started.status}）` : '会话未被接受');
      }
      if (started.sessionId) sessionIdRef.current = started.sessionId;
      if (!mountedRef.current) return;
      setPhase('streaming');

      const deadline = Date.now() + POLL_TIMEOUT_MS;
      let reply = '';
      let done = false;
      // 占位一条 AI 消息，随流式更新
      setMessages((prev) => [...prev, { role: 'ai', text: '' }]);

      while (!done && Date.now() < deadline) {
        if (!mountedRef.current) return;
        const batch = await fetchControlPlaneDeviceNodeSessionRunEvents(profile, nodeId, started.runId, { limit: 200 });
        for (const event of batch.events) {
          if (event.sessionId) sessionIdRef.current = event.sessionId;
          if ((event.type === 'delta' || event.type === 'result') && event.text) reply = event.text;
          if (event.type === 'done') done = true;
        }
        if (reply) {
          setMessages((prev) => {
            const next = [...prev];
            for (let i = next.length - 1; i >= 0; i -= 1) {
              if (next[i].role === 'ai') { next[i] = { role: 'ai', text: reply }; break; }
            }
            return next;
          });
        }
        if (done) break;
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }

      if (!mountedRef.current) return;
      if (!done && !reply) throw new Error('等待回复超时，未收到内容。');
      if (!reply) {
        // 收到 done 但无文本
        setMessages((prev) => {
          const next = [...prev];
          for (let i = next.length - 1; i >= 0; i -= 1) {
            if (next[i].role === 'ai' && !next[i].text) { next[i] = { role: 'ai', text: '（本轮无文本输出）' }; break; }
          }
          return next;
        });
      }
      setPhase('idle');
    } catch (error) {
      if (!mountedRef.current) return;
      setErrorText(error instanceof Error ? error.message : String(error || '发起会话失败'));
      setPhase('error');
    }
  }, [busy, input, nodeId, profile, projectPath, provider]);

  return (
    <div className="fabric-session">
      <div className="fabric-session__bar">
        <Space size="small" wrap>
          <span className="fabric-muted">项目</span>
          <Select
            size="small"
            style={{ minWidth: 200 }}
            value={projectPath || undefined}
            placeholder="选择项目"
            options={projectOptions}
            onChange={(value) => setProjectPath(value)}
            disabled={busy || projectOptions.length === 0}
          />
          <span className="fabric-muted">provider</span>
          <span className="fabric-session__provider">{providerName(provider)}</span>
        </Space>
      </div>

      {projectOptions.length === 0 && (
        <Alert type="info" showIcon message="这台机器还没有可打开的项目，无法发起会话。" style={{ marginBottom: 8 }} />
      )}

      <div className="fabric-session__body" ref={bodyRef}>
        {messages.length === 0 && phase === 'idle' && (
          <Typography.Text type="secondary">输入一条消息，向这台机器上的 {providerName(provider)} 发起真实会话。</Typography.Text>
        )}
        {messages.map((msg, index) => (
          <div key={index} className={`fabric-msg fabric-msg--${msg.role}`}>
            <span className="fabric-msg__who">{msg.role === 'user' ? '你' : providerName(provider)}</span>
            <span className="fabric-msg__text">{msg.text || (msg.role === 'ai' && busy ? '…' : '')}</span>
          </div>
        ))}
        {phase === 'starting' && <div className="fabric-session__status">起会话中…</div>}
        {phase === 'streaming' && <div className="fabric-session__status">回复中…</div>}
      </div>

      {errorText && (
        <Alert type="error" showIcon message={errorText} style={{ marginBottom: 8 }} />
      )}

      <div className="fabric-session__input">
        <Input.TextArea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onPressEnter={(event) => { if (!event.shiftKey) { event.preventDefault(); void send(); } }}
          placeholder="输入消息 / slash… （Enter 发送，Shift+Enter 换行）"
          autoSize={{ minRows: 1, maxRows: 4 }}
          disabled={busy}
        />
        <Button type="primary" onClick={() => void send()} disabled={busy || !input.trim()} loading={busy}>
          发送
        </Button>
      </div>
    </div>
  );
}
