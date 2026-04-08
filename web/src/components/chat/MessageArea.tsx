import { useRef, useEffect, useState, useCallback } from 'react';
import { Select, Empty, Spin } from 'antd';
import { ArrowDownOutlined, PlusOutlined } from '@ant-design/icons';
import type { ChatMessage, Account, Session } from '@/types';
import { modelsAPI } from '@/services/api';
import MessageBubble from './MessageBubble';
import ProviderIcon from './ProviderIcon';
import sendIcon from '@/assets/icons/send.svg';
import disabledSendIcon from '@/assets/icons/disabled-send.svg';
import stopIcon from '@/assets/icons/stop.svg';
import styles from './chat.module.css';

interface Props {
  session: Session | null;
  messages: ChatMessage[];
  accounts: Account[];
  selectedAccount: Account | null;
  selectedModel: string;
  input: string;
  loading: boolean;
  hasMoreHistory?: boolean;
  onLoadMore?: () => void;
  onInputChange: (val: string) => void;
  onSend: () => void;
  onAccountChange: (account: Account) => void;
  onModelChange: (model: string) => void;
}

const MessageArea = ({
  session, messages, accounts, selectedAccount, selectedModel,
  input, loading, hasMoreHistory, onLoadMore, onInputChange, onSend, onAccountChange, onModelChange
}: Props) => {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [showScrollBottom, setShowScrollBottom] = useState(false);
  const [availableModels, setAvailableModels] = useState<Array<{ id: string; owned_by: string }>>([]);

  // 加载可用模型列表
  useEffect(() => {
    modelsAPI.list().then(setAvailableModels).catch(() => {});
  }, []);

  const isInitialLoad = useRef(true);

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    if (isInitialLoad.current) {
      // 首次加载：立即跳到底部（无动画）
      el.scrollTop = el.scrollHeight;
      isInitialLoad.current = false;
    } else {
      // 后续更新：平滑滚动
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages]);

  // 切换会话时重置
  useEffect(() => {
    isInitialLoad.current = true;
  }, [session?.id]);

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
  // 模型列表从 API 获取
  const models = availableModels.map(m => ({ label: m.id, value: m.id }));

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
            {/* 加载更多历史 */}
            {hasMoreHistory && (
              <div style={{ textAlign: 'center', padding: '8px 0 16px' }}>
                <button
                  onClick={onLoadMore}
                  style={{
                    background: '#fff', border: '1px solid #d9d9d9', borderRadius: 16,
                    padding: '4px 16px', cursor: 'pointer', fontSize: 12, color: '#666'
                  }}
                >
                  加载更早的消息
                </button>
              </div>
            )}
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
