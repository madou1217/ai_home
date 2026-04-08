import { useRef, useEffect } from 'react';
import { Input, Button, Select, Space, Empty, Spin, Typography } from 'antd';
import { SendOutlined } from '@ant-design/icons';
import type { ChatMessage, Account, Session } from '@/types';
import MessageBubble from './MessageBubble';
import styles from './chat.module.css';

const { TextArea } = Input;
const { Text } = Typography;

interface Props {
  session: Session | null;
  messages: ChatMessage[];
  accounts: Account[];
  selectedAccount: Account | null;
  input: string;
  loading: boolean;
  onInputChange: (val: string) => void;
  onSend: () => void;
  onAccountChange: (account: Account) => void;
}

const MessageArea = ({
  session, messages, accounts, selectedAccount,
  input, loading, onInputChange, onSend, onAccountChange
}: Props) => {
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  };

  // 只显示匹配当前会话 provider 的账号
  const filteredAccounts = session
    ? accounts.filter(a => a.provider === session.provider)
    : accounts;

  const formatLabel = (acc: Account) => {
    const base = `${acc.provider}-${acc.accountId}`;
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
      <div className={styles.messageArea}>
        {messages.length === 0 ? (
          <div className={styles.emptyCenter}>
            <Empty description="暂无消息记录" />
          </div>
        ) : (
          <div>
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
      </div>

      {/* 输入区域 */}
      <div className={styles.inputArea}>
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Text type="secondary" style={{ fontSize: 13, flexShrink: 0 }}>发送账号:</Text>
            <Select
              style={{ minWidth: 200 }}
              size="small"
              placeholder="选择账号"
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
          <Space.Compact style={{ width: '100%' }}>
            <TextArea
              value={input}
              onChange={e => onInputChange(e.target.value)}
              onKeyPress={handleKeyPress}
              placeholder="输入消息... (Enter 发送，Shift+Enter 换行)"
              autoSize={{ minRows: 2, maxRows: 6 }}
              disabled={loading}
              style={{ flex: 1 }}
            />
            <Button
              type="primary"
              icon={<SendOutlined />}
              onClick={onSend}
              loading={loading}
              style={{ height: 'auto' }}
            >
              发送
            </Button>
          </Space.Compact>
        </Space>
      </div>
    </>
  );
};

export default MessageArea;
