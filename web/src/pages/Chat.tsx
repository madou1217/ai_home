import { useState, useEffect } from 'react';
import { Layout, message } from 'antd';
import { chatAPI, accountsAPI, sessionsAPI } from '@/services/api';
import type { ChatMessage, Account, AggregatedProject, Session } from '@/types';
import { ProjectList, MessageArea } from '@/components/chat';
import { providerNames } from '@/components/chat/ProviderIcon';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import 'dayjs/locale/zh-cn';

dayjs.extend(relativeTime);
dayjs.locale('zh-cn');

const { Sider, Content } = Layout;

const Chat = () => {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [projects, setProjects] = useState<AggregatedProject[]>([]);
  const [selectedSession, setSelectedSession] = useState<Session | null>(null);
  const [selectedAccount, setSelectedAccount] = useState<Account | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingProjects, setLoadingProjects] = useState(false);
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());
  const [selectedModel, setSelectedModel] = useState<string>('');

  // 加载账号
  const loadAccounts = async () => {
    try {
      const data = await accountsAPI.list();
      setAccounts(data.filter(a => a.configured && !a.exhausted));
    } catch {
      message.error('加载账号失败');
    }
  };

  // 加载项目
  const loadProjects = async () => {
    setLoadingProjects(true);
    try {
      const data = await sessionsAPI.getAllProjects();
      const filtered = data.filter(p =>
        p.name !== '默认项目' && p.path && p.path !== '默认项目' && p.path.startsWith('/')
      );
      setProjects(filtered);
      if (filtered.length > 0 && expandedProjects.size === 0) {
        setExpandedProjects(new Set([filtered[0].id]));
      }
    } catch {
      message.error('加载项目失败');
    } finally {
      setLoadingProjects(false);
    }
  };

  useEffect(() => {
    loadAccounts();
    loadProjects();
  }, []);

  // 加载会话消息
  useEffect(() => {
    if (!selectedSession) return;

    const loadMessages = async () => {
      setMessages([]);
      setLoading(true);
      try {
        const history = await sessionsAPI.getSessionMessages(
          selectedSession.provider,
          selectedSession.id,
          selectedSession.projectDirName
        );
        setMessages(history);

        // 自动选择匹配的账号
        if (!selectedAccount || selectedAccount.provider !== selectedSession.provider) {
          const match = accounts.find(a => a.provider === selectedSession.provider);
          if (match) setSelectedAccount(match);
        }
      } catch {
        message.error('加载会话历史失败');
      } finally {
        setLoading(false);
      }
    };

    loadMessages();
  }, [selectedSession]);

  // 发送消息
  const handleSend = async () => {
    if (!input.trim()) return message.warning('请输入消息');
    if (!selectedAccount) return message.warning('请先选择一个账号');
    if (!selectedSession) return message.warning('请先选择一个会话');
    if (selectedAccount.provider !== selectedSession.provider) {
      return message.error(`当前会话来自 ${providerNames[selectedSession.provider]}，请选择对应的账号`);
    }

    const userMsg: ChatMessage = { role: 'user', content: input.trim() };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setInput('');
    setLoading(true);

    try {
      const res = await chatAPI.send({
        messages: newMessages,
        provider: selectedAccount.provider,
        accountId: selectedAccount.accountId,
        model: selectedModel || undefined,
        stream: false
      });
      if (res.ok && res.content) {
        setMessages([...newMessages, { role: 'assistant', content: res.content }]);
      } else {
        message.error(res.error || '发送失败');
      }
    } catch (err: any) {
      message.error(err?.response?.data?.error || err?.response?.data?.message || '发送失败');
    } finally {
      setLoading(false);
    }
  };

  const toggleProject = (id: string) => {
    const next = new Set(expandedProjects);
    next.has(id) ? next.delete(id) : next.add(id);
    setExpandedProjects(next);
  };

  return (
    <Layout style={{ height: '100%', background: '#fff', overflow: 'hidden' }}>
      <Sider
        width={280}
        theme="light"
        breakpoint="md"
        collapsedWidth={0}
        style={{
          borderRight: '1px solid #e8e8e8',
          height: '100%',
          background: '#f5f5f5'
        }}
      >
        <ProjectList
          projects={projects}
          loading={loadingProjects}
          selectedSession={selectedSession}
          expandedProjects={expandedProjects}
          onRefresh={loadProjects}
          onToggleProject={toggleProject}
          onSelectSession={setSelectedSession}
        />
      </Sider>

      <Content style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
        <MessageArea
          session={selectedSession}
          messages={messages}
          accounts={accounts}
          selectedAccount={selectedAccount}
          selectedModel={selectedModel}
          input={input}
          loading={loading}
          onInputChange={setInput}
          onSend={handleSend}
          onAccountChange={setSelectedAccount}
          onModelChange={setSelectedModel}
        />
      </Content>
    </Layout>
  );
};

export default Chat;
