import { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { Select, Empty, Button, Drawer, Tooltip } from 'antd';
import { ArrowDownOutlined, PlusOutlined, CloseOutlined, InfoCircleOutlined } from '@ant-design/icons';
import type { ChatMessage, Account, Session, NativeSlashCommand, QueuedChatMessage } from '@/types';
import { chatAPI, modelsAPI } from '@/services/api';
import MessageBubble from './MessageBubble';
import ProviderIcon from './ProviderIcon';
import TaskDock from './TaskDock';
import { findLatestActiveChecklist } from './message-structure';
import { decorateMessagesWithPendingState } from './live-message-state.js';
import { resolvePendingTailState } from './pending-tail-state.js';
import { normalizePendingStatusText } from './provider-pending-policy.js';
import { getAccountIdentityLabel } from '@/utils/account-labels';
import {
  getQueueModeDescription,
  getQueueModeLabel,
  getQueuePrimaryActionLabel,
  getQueuePrimaryActionTitle
} from './queue-presentation.js';
import sendIcon from '@/assets/icons/send.svg';
import disabledSendIcon from '@/assets/icons/disabled-send.svg';
import stopIcon from '@/assets/icons/stop.svg';
import styles from './chat.module.css';

const PendingTailStatusLine = ({ text }: { text: string }) => {
  const chars = Array.from(text || '');
  return (
    <div className={styles.pendingTailStatus} aria-live="polite" aria-label={text}>
      {chars.map((char, index) => (
        <span
          key={`${char}-${index}`}
          className={styles.pendingTailChar}
          style={{ animationDelay: `${index * 0.08}s` }}
          aria-hidden="true"
        >
          {char === ' ' ? '\u00A0' : char}
        </span>
      ))}
    </div>
  );
};

const isChatSelectableAccount = (account: Account) => {
  if (!account.configured) return false;
  if (account.status === 'down') return false;
  if (String(account.schedulableStatus || '').trim() && account.schedulableStatus !== 'schedulable') return false;
  const runtimeStatus = String(account.runtimeStatus || '').trim();
  if (runtimeStatus && runtimeStatus !== 'healthy') return false;
  return true;
};

function findCodexUsageWindow(account: Account, window: '5h' | '7days') {
  if (account.provider !== 'codex' || account.apiKeyMode) return null;
  const snapshot = account.usageSnapshot;
  if (!snapshot || snapshot.kind !== 'codex_oauth_status' || !Array.isArray(snapshot.entries)) return null;
  const entry = snapshot.entries.find((item) => String(item.window || '').trim().toLowerCase() === window);
  if (!entry || entry.remainingPct == null) return null;
  const numeric = Number(entry.remainingPct);
  return Number.isFinite(numeric) ? Math.round(numeric) : null;
}

function formatChatAccountLabel(account: Account) {
  const base = getAccountIdentityLabel(account);
  if (!base) return '';
  if (account.apiKeyMode) return base;

  const shortWindowRemaining = findCodexUsageWindow(account, '5h');
  const weeklyRemaining = findCodexUsageWindow(account, '7days');
  if (shortWindowRemaining != null || weeklyRemaining != null) {
    const usageParts = [
      shortWindowRemaining != null ? `d:${shortWindowRemaining}%` : '',
      weeklyRemaining != null ? `w:${weeklyRemaining}%` : ''
    ].filter(Boolean);
    return `${base} · ${usageParts.join(',')}`;
  }

  if (account.remainingPct != null) {
    return `${base} · ${Math.round(account.remainingPct)}%`;
  }
  return base;
}

interface Props {
  mobile?: boolean;
  session: Session | null;
  messages: ChatMessage[];
  accounts: Account[];
  selectedAccount: Account | null;
  selectedModel: string;
  input: string;
  loading: boolean;
  loadingStatusText?: string;
  queuedMessages?: QueuedChatMessage[];
  externalPending?: boolean;
  externalPendingStatusText?: string;
  hasMoreHistory?: boolean;
  images?: string[]; // base64 图片列表
  onLoadMore?: () => void;
  onInputChange: (val: string) => void;
  onSend: () => void;
  onStop: () => void;
  onEditQueuedMessage?: (id: string) => void;
  onRemoveQueuedMessage?: (id: string) => void;
  onSendQueuedMessageNow?: (id: string) => void;
  onAccountChange: (account: Account) => void;
  onModelChange: (model: string) => void;
  onImagesChange?: (images: string[]) => void;
}

const MessageArea = ({
  mobile = false,
  session, messages, accounts, selectedAccount, selectedModel,
  input, loading, loadingStatusText, queuedMessages = [], externalPending = false, externalPendingStatusText, hasMoreHistory, images = [], onLoadMore, onInputChange,
  onSend, onStop, onEditQueuedMessage, onRemoveQueuedMessage, onSendQueuedMessageNow, onAccountChange, onModelChange, onImagesChange
}: Props) => {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingVisualTsRef = useRef<number>(Date.now());
  const [showScrollBottom, setShowScrollBottom] = useState(false);
  const [modelsByProvider, setModelsByProvider] = useState<Record<string, string[]>>({});
  const [slashCommands, setSlashCommands] = useState<NativeSlashCommand[]>([]);
  const [selectedSlashIndex, setSelectedSlashIndex] = useState(0);
  const [mobileControlsOpen, setMobileControlsOpen] = useState(false);
  const activeProvider = session
    ? (session.draft ? (selectedAccount?.provider || session.provider) : session.provider)
    : '';

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

  useEffect(() => {
    if (!session) {
      setSlashCommands([]);
      return;
    }
    const provider = activeProvider;
    let cancelled = false;
    chatAPI.getSlashCommands(provider)
      .then((commands) => {
        if (!cancelled) setSlashCommands(commands);
      })
      .catch(() => {
        if (!cancelled) setSlashCommands([]);
      });
    return () => {
      cancelled = true;
    };
  }, [activeProvider, selectedAccount?.provider, session]);

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

  const filteredAccounts = (session && !session.draft
    ? accounts.filter((account) => account.provider === session.provider)
    : accounts
  ).filter(isChatSelectableAccount);

  const mobileAccountSummary = selectedAccount
    ? `${selectedAccount.provider.toUpperCase()} · ${formatChatAccountLabel(selectedAccount)}`
    : '未选择账号';
  const sessionProvider = session?.provider || activeProvider || 'codex';

  const trimmedInput = input.trim();
  const slashToken = trimmedInput.startsWith('/')
    ? trimmedInput.split(/\s+/, 1)[0]
    : '';
  const matchedSlashCommand = slashToken
    ? slashCommands.find((item) => item.command === slashToken || item.aliases.some((alias) => alias === slashToken)) || null
    : null;
  const slashMatches = slashToken
    ? slashCommands.filter((item) =>
      slashToken === '/'
      || item.command.startsWith(slashToken)
      || item.aliases.some((alias) => alias.startsWith(slashToken))
    )
    : [];
  const hasUnsupportedSlashCommand = Boolean(slashToken) && !matchedSlashCommand && slashMatches.length === 0;
  const embeddedSlashMatch = !trimmedInput.startsWith('/')
    ? slashCommands.find((item) => {
        const tokens = trimmedInput.split(/\s+/).filter(Boolean);
        return tokens.includes(item.command) || item.aliases.some((alias) => tokens.includes(alias));
      }) || null
    : null;
  const canSend = trimmedInput.length > 0
    && !embeddedSlashMatch
    && (!slashToken || Boolean(matchedSlashCommand));
  // 按当前 provider 过滤模型
  const providerModels = (activeProvider && modelsByProvider[activeProvider]) || [];
  const models = providerModels.map(m => ({ label: m, value: m }));

  const displayMessages = useMemo(() => {
    const pendingState = decorateMessagesWithPendingState({
      messages,
      loading,
      externalPending,
      loadingStatusText,
      externalPendingStatusText,
      activeProvider,
      pendingTimestamp: pendingVisualTsRef.current
    });
    if (pendingState.usedSyntheticPending) {
      pendingVisualTsRef.current = Date.now();
    }
    return pendingState.messages;
  }, [activeProvider, externalPending, externalPendingStatusText, loading, loadingStatusText, messages]);

  const renderedMessageNodes = useMemo(() => (
    displayMessages.map((msg, i) => (
      <MessageBubble
        key={`${msg.role}-${i}-${msg.pending ? 'pending' : 'done'}`}
        message={msg}
        provider={sessionProvider}
        mobile={mobile}
      />
    ))
  ), [displayMessages, mobile, sessionProvider]);

  const activeChecklist = useMemo(
    () => findLatestActiveChecklist(displayMessages),
    [displayMessages]
  );
  const pendingTail = useMemo(() => {
    const state = resolvePendingTailState({
      messages: displayMessages,
      loading,
      externalPending,
      loadingStatusText,
      externalPendingStatusText,
      activeProvider
    });
    return {
      visible: state.visible,
      statusText: normalizePendingStatusText(state.statusText, sessionProvider)
    };
  }, [
    activeProvider,
    displayMessages,
    externalPending,
    externalPendingStatusText,
    loading,
    loadingStatusText,
    sessionProvider
  ]);
  const hasComposerDock = Boolean(activeChecklist) || queuedMessages.length > 0;
  const helperFontSize = mobile ? 13 : 12;
  const helperMutedFontSize = mobile ? 12 : 11;
  const selectFontSize = mobile ? 14 : 13;

  useEffect(() => {
    if (!session) return;
    if (providerModels.length === 0) return;
    if (selectedModel && providerModels.includes(selectedModel)) return;
    onModelChange(providerModels[0]);
  }, [onModelChange, providerModels, selectedModel, session]);

  const applySlashCommand = useCallback((command: NativeSlashCommand | null) => {
    if (!command) return;
    const suffix = command.argumentHint ? ' ' : '';
    onInputChange(`${command.command}${suffix}`);
  }, [onInputChange]);

  useEffect(() => {
    if (slashMatches.length === 0) {
      setSelectedSlashIndex(0);
      return;
    }
    setSelectedSlashIndex((current) => Math.min(current, slashMatches.length - 1));
  }, [slashMatches.length]);

  const handleComposerKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashToken) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onInputChange('');
        return;
      }

      if (slashMatches.length > 0 && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault();
        setSelectedSlashIndex((current) => {
          if (slashMatches.length === 0) return 0;
          if (e.key === 'ArrowDown') return (current + 1) % slashMatches.length;
          return (current - 1 + slashMatches.length) % slashMatches.length;
        });
        return;
      }

      if (slashMatches.length > 0 && e.key === 'Tab') {
        e.preventDefault();
        applySlashCommand(slashMatches[selectedSlashIndex] || slashMatches[0] || null);
        return;
      }

      if (e.key === 'Enter' && !e.shiftKey) {
        if (embeddedSlashMatch || hasUnsupportedSlashCommand) {
          e.preventDefault();
          return;
        }
        if (!matchedSlashCommand && slashMatches.length > 0) {
          e.preventDefault();
          applySlashCommand(slashMatches[selectedSlashIndex] || slashMatches[0] || null);
          return;
        }
      }
    }

    if (embeddedSlashMatch && e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      return;
    }

    handleKeyDown(e);
  }, [
    applySlashCommand,
    embeddedSlashMatch,
    handleKeyDown,
    hasUnsupportedSlashCommand,
    matchedSlashCommand,
    onInputChange,
    selectedSlashIndex,
    slashMatches,
    slashToken
  ]);

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
      <div className={`${styles.messageArea} ${mobile ? styles.messageAreaMobile : ''}`} ref={scrollContainerRef} onScroll={handleScroll}>
        <div className={styles.messageThread}>
          {displayMessages.length === 0 ? (
            <div className={styles.welcomeState}>
              <div className={styles.welcomeTitle}>你今天想聊些什么？</div>
              <div className={styles.welcomeHint}>
                选择项目后直接开始对话，图片和系统输入法语音输入都可以使用。
              </div>
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
                    padding: mobile ? '6px 16px' : '4px 16px', cursor: 'pointer', fontSize: mobile ? 13 : 12, color: '#666'
                  }}
                >
                  加载更早的消息
                </button>
              </div>
            )}
            {renderedMessageNodes}
            {pendingTail.visible ? (
              <div className={styles.pendingTailRow}>
                <PendingTailStatusLine text={pendingTail.statusText || '正在思考中'} />
              </div>
            ) : null}
              <div ref={messagesEndRef} />
            </div>
          )}
        </div>

        {showScrollBottom && (
          <button onClick={scrollToBottom} className={styles.scrollBottomBtn}>
            <ArrowDownOutlined />
          </button>
        )}
      </div>

      {/* ChatGPT 风格输入区域 */}
      <div className={`${styles.inputArea} ${mobile ? styles.inputAreaMobile : ''}`}>
        <div className={styles.composerShell}>
          {hasComposerDock ? (
            <div className={styles.composerDockStack}>
            {activeChecklist ? <TaskDock checklist={activeChecklist} className={styles.composerDockCard} /> : null}
            {queuedMessages.length > 0 ? (
              <div className={`${styles.queueDock} ${styles.composerDockCard}`}>
                <div className={styles.queueDockHeader}>
                  <span className={styles.queueDockTitle}>{`排队消息 ${queuedMessages.length}`}</span>
                  <span className={styles.queueDockHint}>
                    运行中继续输入的需求会在这里排队
                  </span>
                </div>
            {queuedMessages.map((item, index) => (
              <div key={item.id} className={styles.queueItem}>
                <div className={styles.queueGrip} aria-hidden="true">⋮⋮</div>
                <button
                  type="button"
                  className={styles.queueContent}
                  onClick={() => onEditQueuedMessage?.(item.id)}
                  title="编辑排队消息"
                >
                  <span className={styles.queuePreview}>
                    {item.content}
                  </span>
                </button>
                <div className={styles.queueActions}>
                  <span className={styles.queueActionHintWrap}>
                    <span className={styles.queueActionHint}>
                      {getQueueModeLabel(item.mode, index)}
                    </span>
                    {index === 0 ? (
                      <Tooltip
                        placement="topRight"
                        title={getQueueModeDescription(item.mode)}
                      >
                        <button
                          type="button"
                          className={styles.queueInfoBtn}
                          aria-label="排队说明"
                        >
                          <InfoCircleOutlined />
                        </button>
                      </Tooltip>
                    ) : null}
                  </span>
                  <button
                    type="button"
                    className={styles.queueActionBtn}
                    onClick={() => onSendQueuedMessageNow?.(item.id)}
                    title={getQueuePrimaryActionTitle(loading, index)}
                  >
                    {getQueuePrimaryActionLabel(loading, index)}
                  </button>
                  <button
                    type="button"
                    className={styles.queueActionBtn}
                    onClick={() => onEditQueuedMessage?.(item.id)}
                    title="编辑消息"
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    className={styles.queueActionBtn}
                    onClick={() => onRemoveQueuedMessage?.(item.id)}
                    title="删除排队"
                  >
                    删除
                  </button>
                </div>
              </div>
            ))}
              </div>
            ) : null}
            </div>
          ) : null}
          <div className={`${styles.inputBox} ${mobile ? styles.inputBoxMobile : ''}`}>
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
            onKeyDown={handleComposerKeyDown}
            onPaste={handlePaste}
            placeholder={mobile ? '输入消息，系统输入法可直接语音输入' : '输入消息...'}
            rows={1}
          />
          {slashToken && (
            <div style={{
              padding: '0 12px 8px',
              fontSize: helperFontSize,
              color: hasUnsupportedSlashCommand ? '#cf1322' : '#2468d6'
            }}>
              {matchedSlashCommand ? (
                <>
                  命令模式：<strong>{matchedSlashCommand.command}</strong>
                  {matchedSlashCommand.argumentHint ? ` ${matchedSlashCommand.argumentHint}` : ''}
                  {' '}· {matchedSlashCommand.description}
                  {matchedSlashCommand.aliases.length > 0 ? ` · 别名：${matchedSlashCommand.aliases.join(', ')}` : ''}
                </>
              ) : hasUnsupportedSlashCommand ? (
                <>
                  未识别的命令 <strong>{slashToken}</strong>。请选择下方建议命令，或输入完整有效命令后再发送。
                </>
              ) : (
                <>
                  正在选择命令。Slash 命令必须单独发送，可在命令后附带参数，但不能和普通聊天文本混发。
                </>
              )}
            </div>
          )}
          {slashMatches.length > 0 && (
            <div style={{ padding: '0 12px 8px' }}>
              <div style={{ marginBottom: 6, fontSize: helperMutedFontSize, color: '#6b7280' }}>
                ↑↓ 切换命令 · Tab 补全 · Enter 选择 · Esc 退出
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {slashMatches.map((item, index) => {
                  const active = index === selectedSlashIndex;
                  return (
                    <button
                      key={item.command}
                      type="button"
                      onMouseEnter={() => setSelectedSlashIndex(index)}
                      onClick={() => applySlashCommand(item)}
                      title={item.description}
                      style={{
                        border: active ? '1px solid #91caff' : '1px solid #d9e8ff',
                        background: active ? '#e6f4ff' : '#f5f9ff',
                        color: '#2468d6',
                        borderRadius: 12,
                        fontSize: helperFontSize,
                        lineHeight: '18px',
                        padding: '8px 10px',
                        cursor: 'pointer',
                        textAlign: 'left'
                      }}
                    >
                      <div style={{ fontWeight: 600 }}>
                        {item.command}
                        {item.argumentHint ? ` ${item.argumentHint}` : ''}
                      </div>
                      <div style={{ marginTop: 2, color: '#5b6b88' }}>
                        {item.description}
                        {item.aliases.length > 0 ? ` · 别名：${item.aliases.join(', ')}` : ''}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {embeddedSlashMatch && (
            <div style={{ padding: '0 12px 8px', fontSize: helperFontSize, color: '#c25100' }}>
              检测到命令 {embeddedSlashMatch.command}。Slash 命令必须单独发送，不能和普通文本混在同一条消息里。
            </div>
          )}
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
              {mobile ? (
                <button
                  type="button"
                  className={styles.mobileMetaBtn}
                  onClick={() => setMobileControlsOpen(true)}
                >
                  <div className={styles.mobileComposerMeta}>
                    <span>{mobileAccountSummary}</span>
                    <span>{selectedModel || activeProvider || '默认模型'}</span>
                  </div>
                </button>
              ) : (
                <Select
                  size="small"
                  variant="borderless"
                  value={selectedModel || models[0]?.value}
                  onChange={onModelChange}
                  options={models}
                  style={{ fontSize: selectFontSize }}
                  popupMatchSelectWidth={false}
                />
              )}
            </div>
            <div className={styles.inputToolbarRight}>
              {!mobile ? (
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
                      <ProviderIcon provider={acc.provider} size={12} />
                      <span>{formatChatAccountLabel(acc)}</span>
                      {acc.apiKeyMode ? <span title="API Key">key</span> : null}
                    </span>,
                    value: `${acc.provider}-${acc.accountId}`
                  }))}
                  popupMatchSelectWidth={false}
                  style={{ fontSize: selectFontSize }}
                />
              ) : null}
              {/* 发送/停止按钮 */}
              {loading ? (
                <button
                  className={styles.stopBtn}
                  onClick={onStop}
                  title="停止当前会话"
                >
                  <img src={stopIcon} alt="stop" style={{ width: 18, height: 18 }} />
                </button>
              ) : null}
              <button
                className={`${styles.sendBtn} ${canSend ? styles.sendBtnActive : ''}`}
                onClick={() => {
                  if (canSend && !embeddedSlashMatch) onSend();
                }}
                disabled={!canSend || Boolean(embeddedSlashMatch)}
                title={loading ? '加入排队' : '发送'}
              >
                <img src={canSend ? sendIcon : disabledSendIcon} alt="send" style={{ width: 20, height: 20 }} />
              </button>
            </div>
          </div>
          </div>
        </div>
      </div>
      {mobile ? (
        <Drawer
          placement="bottom"
          height="auto"
          open={mobileControlsOpen}
          onClose={() => setMobileControlsOpen(false)}
          title="聊天设置"
          className={styles.mobileControlsDrawer}
          styles={{
            header: { padding: '14px 16px 10px', borderBottom: 'none' },
            body: { padding: '0 16px calc(16px + env(safe-area-inset-bottom))' },
            content: { borderRadius: '24px 24px 0 0', overflow: 'hidden' }
          }}
        >
          <div className={styles.mobileSheetHandle} />
          <div className={styles.mobileControlsSection}>
            <div className={styles.mobileControlsLabel}>账号</div>
            <Select
              value={selectedAccount ? `${selectedAccount.provider}-${selectedAccount.accountId}` : undefined}
              onChange={(value) => {
                const [provider, accountId] = value.split('-');
                const account = accounts.find(a => a.provider === provider && a.accountId === accountId);
                if (account) onAccountChange(account);
              }}
              options={filteredAccounts.map(acc => ({
                label: <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <ProviderIcon provider={acc.provider} size={14} />
                  <span>{formatChatAccountLabel(acc)}</span>
                  {acc.apiKeyMode ? <span title="API Key">key</span> : null}
                </span>,
                value: `${acc.provider}-${acc.accountId}`
              }))}
              style={{ width: '100%' }}
              size="large"
            />
          </div>
          <div className={styles.mobileControlsSection}>
            <div className={styles.mobileControlsLabel}>模型</div>
            <Select
              value={selectedModel || models[0]?.value}
              onChange={onModelChange}
              options={models}
              style={{ width: '100%' }}
              size="large"
            />
          </div>
          <div className={styles.mobileVoiceHint}>
            语音输入直接使用系统输入法麦克风即可，这里不单独接管录音。
          </div>
          <Button type="primary" block size="large" onClick={() => setMobileControlsOpen(false)}>
            完成
          </Button>
        </Drawer>
      ) : null}
    </>
  );
};

export default MessageArea;
