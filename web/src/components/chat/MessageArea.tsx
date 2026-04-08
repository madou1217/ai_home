import { useRef, useEffect, useState, useCallback } from 'react';
import { Select, Empty, Spin } from 'antd';
import { ArrowDownOutlined, PlusOutlined, CloseOutlined } from '@ant-design/icons';
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
  images?: string[]; // base64 图片列表
  onLoadMore?: () => void;
  onInputChange: (val: string) => void;
  onSend: () => void;
  onAccountChange: (account: Account) => void;
  onModelChange: (model: string) => void;
  onImagesChange?: (images: string[]) => void;
}

const MessageArea = ({
  session, messages, accounts, selectedAccount, selectedModel,
  input, loading, hasMoreHistory, images = [], onLoadMore, onInputChange,
  onSend, onAccountChange, onModelChange, onImagesChange
}: Props) => {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [showScrollBottom, setShowScrollBottom] = useState(false);
  const [modelsByProvider, setModelsByProvider] = useState<Record<string, string[]>>({});

  // 处理粘贴图片
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (!file) continue;
        const reader = new FileReader();
        reader.onload = () => {
          const base64 = reader.result as string;
          onImagesChange?.([...images, base64]);
        };
        reader.readAsDataURL(file);
        break;
      }
    }
  }, [images, onImagesChange]);

  // 处理文件选择
  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    for (const file of Array.from(files)) {
      if (file.type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onload = () => {
          const base64 = reader.result as string;
          onImagesChange?.([...images, base64]);
        };
        reader.readAsDataURL(file);
      }
    }
    e.target.value = ''; // reset
  };

  const removeImage = (idx: number) => {
    onImagesChange?.(images.filter((_, i) => i !== idx));
  };

  // 加载按 provider 分组的模型列表
  useEffect(() => {
    modelsAPI.listByProvider().then(setModelsByProvider).catch(() => {});
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
  // 按当前 provider 过滤模型
  const providerModels = (modelsByProvider[session.provider] || []);
  const models = providerModels.map(m => ({ label: m, value: m }));

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
          {/* 图片预览 */}
          {images.length > 0 && (
            <div className={styles.imagePreviewRow}>
              {images.map((img, idx) => (
                <div key={idx} className={styles.imagePreviewItem}>
                  <img src={img} alt="" className={styles.imagePreviewImg} />
                  <button className={styles.imageRemoveBtn} onClick={() => removeImage(idx)}>
                    <CloseOutlined style={{ fontSize: 10 }} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <textarea
            ref={textareaRef}
            className={styles.inputTextarea}
            value={input}
            onChange={e => onInputChange(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder="输入消息..."
            disabled={loading}
            rows={1}
          />
          {/* 隐藏文件输入 */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            style={{ display: 'none' }}
            onChange={handleFileSelect}
          />
          {/* 底部工具栏 */}
          <div className={styles.inputToolbar}>
            <div className={styles.inputToolbarLeft}>
              <button
                className={styles.inputToolbarBtn}
                title="上传图片"
                onClick={() => fileInputRef.current?.click()}
              >
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
