import { useRef, useEffect, useState } from 'react';
import { Input, Button, Select, Empty, Spin } from 'antd';
import { SendOutlined, ArrowDownOutlined } from '@ant-design/icons';
import type { ChatMessage, Account, Session } from '@/types';
import MessageBubble from './MessageBubble';
import ProviderIcon from './ProviderIcon';
import styles from './chat.module.css';

const { TextArea } = Input;

// Provider 默认模型列表
const PROVIDER_MODELS: Record<string, Array<{ label: string; value: string }>> = {
  codex: [
    { label: 'GPT-4o', value: 'gpt-4o' },
    { label: 'GPT-4o Mini', value: 'gpt-4o-mini' },
    { label: 'o3', value: 'o3' },
    { label: 'o4-mini', value: 'o4-mini' },
  ],
  claude: [
    { label: 'Sonnet 4', value: 'claude-sonnet-4-20250514' },
    { label: 'Opus 4', value: 'claude-opus-4-20250514' },
    { label: 'Haiku 3.5', value: 'claude-haiku-4-5-20251001' },
  ],
  gemini: [
    { label: 'Gemini 2.5 Pro', value: 'gemini-2.5-pro' },
    { label: 'Gemini 2.5 Flash', value: 'gemini-2.5-flash' },
    { label: 'Gemini 2.0 Flash', value: 'gemini-2.0-flash' },
  ]
};

interface Props {
  session: Session | null;
  messages: ChatMessage[];
  accounts: Account[];
  selectedAccount: Account | null;
  selectedModel: string;
  input: string;
  loading: boolean;
  onInputChange: (val: string) => void;
  onSend: () => void;
  onAccountChange: (account: Account) => void;
  onModelChange: (model: string) => void;
}

const MessageArea = ({
  session, messages, accounts, selectedAccount, selectedModel,
  input, loading, onInputChange, onSend, onAccountChange, onModelChange
}: Props) => {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [showScrollBottom, setShowScrollBottom] = useState(false);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // 监听滚动位置，决定是否显示"回到底部"
  const handleScroll = () => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setShowScrollBottom(distanceFromBottom > 200);
  };

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (input.trim()) onSend();
    }
  };

  const filteredAccounts = session
    ? accounts.filter(a => a.provider === session.provider)
    : accounts;

  const formatLabel = (acc: Account) => {
    const base = `${acc.accountId}`;
    return !acc.apiKeyMode && acc.remainingPct !== undefined
      ? `${base} (${Math.round(acc.remainingPct)}%)`
      : base;
  };

  if (!session) {
    return (
      <div className={styles.emptyCenter}>
        <Empty description="选择一个会话开始对话" />
      </div>
    );
  }

  return (
    <>
      {/* 消息列表 */}
      <div
        className={styles.messageArea}
        ref={scrollContainerRef}
        onScroll={handleScroll}
      >
        {messages.length === 0 ? (
          <div className={styles.emptyCenter}>
            <Empty description="暂无消息记录" />
          </div>
        ) : (
          <div style={{ paddingBottom: 24 }}>
            {messages.map((msg, i) => (
              <MessageBubble key={i} message={msg} provider={session.provider} />
            ))}
            {loading && (
              <div style={{ textAlign: 'center', padding: 16 }}>
                <Spin tip="AI 正在思考..." />
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        )}

        {/* 回到底部按钮 */}
        {showScrollBottom && (
          <button
            onClick={scrollToBottom}
            style={{
              position: 'sticky',
              bottom: 16,
              left: '50%',
              transform: 'translateX(-50%)',
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              padding: '6px 16px',
              background: '#fff',
              border: '1px solid #d9d9d9',
              borderRadius: 20,
              boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
              cursor: 'pointer',
              fontSize: 12,
              color: '#666',
              zIndex: 5
            }}
          >
            <ArrowDownOutlined /> 回到底部
          </button>
        )}
      </div>

      {/* 输入区域 */}
      <div className={styles.inputArea}>
        <div style={{ display: 'flex', gap: 8 }}>
          <TextArea
            value={input}
            onChange={e => onInputChange(e.target.value)}
            onKeyPress={handleKeyPress}
            placeholder="输入消息... (Enter 发送，Shift+Enter 换行)"
            autoSize={{ minRows: 1, maxRows: 6 }}
            disabled={loading}
            style={{ flex: 1, borderRadius: 8 }}
          />
          <Button
            type="primary"
            icon={<SendOutlined />}
            onClick={onSend}
            loading={loading}
            disabled={!input.trim() && !loading}
            style={{ height: 'auto', borderRadius: 8, alignSelf: 'flex-end' }}
          />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
          <ProviderIcon provider={session.provider} size={14} />
          <Select
            style={{ minWidth: 120 }}
            size="small"
            variant="borderless"
            placeholder="模型"
            value={selectedModel || undefined}
            onChange={onModelChange}
            options={(PROVIDER_MODELS[session.provider] || []).map(m => ({
              label: m.label,
              value: m.value
            }))}
            allowClear
          />
          <span style={{ color: '#d9d9d9' }}>|</span>
          <Select
            style={{ minWidth: 100 }}
            size="small"
            variant="borderless"
            placeholder="账号"
            value={selectedAccount ? `${selectedAccount.provider}-${selectedAccount.accountId}` : undefined}
            onChange={(value) => {
              const [provider, accountId] = value.split('-');
              const account = accounts.find(a => a.provider === provider && a.accountId === accountId);
              if (account) onAccountChange(account);
            }}
            options={filteredAccounts.map(acc => ({
              label: formatLabel(acc),
              value: `${acc.provider}-${acc.accountId}`
            }))}
          />
        </div>
      </div>
    </>
  );
};

export default MessageArea;
