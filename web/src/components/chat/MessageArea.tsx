import { useRef, useEffect, useState, useCallback } from 'react';
import { Select, Empty, Spin } from 'antd';
import { ArrowDownOutlined, PlusOutlined } from '@ant-design/icons';
import type { ChatMessage, Account, Session } from '@/types';
import MessageBubble from './MessageBubble';
import ProviderIcon from './ProviderIcon';
import sendIcon from '@/assets/icons/send.svg';
import disabledSendIcon from '@/assets/icons/disabled-send.svg';
import stopIcon from '@/assets/icons/stop.svg';
import styles from './chat.module.css';

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
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [showScrollBottom, setShowScrollBottom] = useState(false);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleScroll = () => {
    const el = scrollContainerRef.current;
    if (!el) return;
    setShowScrollBottom(el.scrollHeight - el.scrollTop - el.clientHeight > 200);
  };

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (input.trim() && !loading) onSend();
    }
  }, [input, loading, onSend]);

  // 自动调整 textarea 高度
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  }, [input]);

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

  const canSend = input.trim().length > 0 && !loading;
  const models = PROVIDER_MODELS[session.provider] || [];

  return (
    <>
      {/* 消息列表 */}
      <div className={styles.messageArea} ref={scrollContainerRef} onScroll={handleScroll}>
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

        {showScrollBottom && (
          <button onClick={scrollToBottom} className={styles.scrollBottomBtn}>
            <ArrowDownOutlined />
          </button>
        )}
      </div>

      {/* ChatGPT 风格输入区域 */}
      <div className={styles.inputArea}>
        <div className={styles.inputBox}>
          <textarea
            ref={textareaRef}
            className={styles.inputTextarea}
            value={input}
            onChange={e => onInputChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="输入消息..."
            disabled={loading}
            rows={1}
          />
          {/* 底部工具栏 */}
          <div className={styles.inputToolbar}>
            <div className={styles.inputToolbarLeft}>
              <button className={styles.inputToolbarBtn} title="附件">
                <PlusOutlined style={{ fontSize: 16 }} />
              </button>
              <Select
                size="small"
                variant="borderless"
                value={selectedModel || models[0]?.value}
                onChange={onModelChange}
                options={models}
                style={{ fontSize: 13 }}
                popupMatchSelectWidth={false}
              />
            </div>
            <div className={styles.inputToolbarRight}>
              {/* 账号选择 */}
              <Select
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
                  label: <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <ProviderIcon provider={acc.provider} size={12} /> {formatLabel(acc)}
                  </span>,
                  value: `${acc.provider}-${acc.accountId}`
                }))}
                popupMatchSelectWidth={false}
                style={{ fontSize: 13 }}
              />
              {/* 发送/停止按钮 */}
              <button
                className={`${styles.sendBtn} ${canSend ? styles.sendBtnActive : ''}`}
                onClick={() => { if (canSend) onSend(); }}
                disabled={!canSend && !loading}
              >
                {loading ? (
                  <img src={stopIcon} alt="stop" style={{ width: 20, height: 20 }} />
                ) : (
                  <img src={canSend ? sendIcon : disabledSendIcon} alt="send" style={{ width: 20, height: 20 }} />
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
};

export default MessageArea;
