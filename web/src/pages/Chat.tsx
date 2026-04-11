import { useState, useEffect, useRef } from 'react';
import { Layout, message, Empty, Button, Modal, Input } from 'antd';
import { chatAPI, accountsAPI, sessionsAPI } from '@/services/api';
import type { ChatMessage, Account, AggregatedProject, Session, ChatStreamEvent } from '@/types';
import { ProjectList, MessageArea } from '@/components/chat';
import { providerNames } from '@/components/chat/ProviderIcon';
import { FolderOpenOutlined, PlusOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import 'dayjs/locale/zh-cn';

dayjs.extend(relativeTime);
dayjs.locale('zh-cn');

const { Sider, Content } = Layout;
const Chat = () => {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [projects, setProjects] = useState<AggregatedProject[]>([]);
  const [selectedProject, setSelectedProject] = useState<AggregatedProject | null>(null);
  const [selectedSession, setSelectedSession] = useState<Session | null>(null);
  const [selectedAccount, setSelectedAccount] = useState<Account | null>(null);
  const [allMessages, setAllMessages] = useState<ChatMessage[]>([]); // 完整消息列表
  const [messages, setMessages] = useState<ChatMessage[]>([]); // 当前显示的消息
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingProjects, setLoadingProjects] = useState(false);
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [images, setImages] = useState<string[]>([]);
  const [openProjectVisible, setOpenProjectVisible] = useState(false);
  const [openProjectPath, setOpenProjectPath] = useState('');
  const [openProjectName, setOpenProjectName] = useState('');
  const [pickingProject, setPickingProject] = useState(false);
  const selectedSessionRef = useRef<Session | null>(null);
  const streamAbortRef = useRef<AbortController | null>(null);

  const INITIAL_MSG_COUNT = 30; // 初始加载条数
  const LOAD_MORE_COUNT = 20; // 每次加载更多

  const dropPendingAssistantPlaceholder = () => {
    setMessages((current) => {
      if (current.length === 0) return current;
      const next = current.slice();
      const last = next[next.length - 1];
      if (last && last.role === 'assistant' && last.pending) {
        next.pop();
      }
      return next;
    });
  };

  // 加载更多历史消息
  const loadMoreHistory = () => {
    const currentLen = messages.length;
    const totalLen = allMessages.length;
    if (currentLen >= totalLen) return;
    const moreCount = Math.min(LOAD_MORE_COUNT, totalLen - currentLen);
    const startIdx = totalLen - currentLen - moreCount;
    setMessages(allMessages.slice(Math.max(0, startIdx)));
    setHasMoreHistory(startIdx > 0);
  };

  const findProjectBySessionId = (items: AggregatedProject[], sessionId: string) => {
    for (const project of items) {
      const matched = project.sessions.find((session) => session.id === sessionId);
      if (matched) {
        return { project, session: matched };
      }
    }
    return null;
  };

  const fetchProjects = async () => {
    const data = await sessionsAPI.getAllProjects();
    return data.filter(p =>
      p.name !== '默认项目' && p.path && p.path !== '默认项目' && p.path.startsWith('/')
    );
  };

  const applySessionHistory = (history: ChatMessage[]) => {
    setAllMessages(history);
    if (history.length > INITIAL_MSG_COUNT) {
      setMessages(history.slice(-INITIAL_MSG_COUNT));
      setHasMoreHistory(true);
    } else {
      setMessages(history);
      setHasMoreHistory(false);
    }
  };

  const reloadSessionHistory = async (session: Session) => {
    if (session.draft) return;
    const history = await sessionsAPI.getSessionMessages(
      session.provider,
      session.id,
      session.projectDirName
    );
    if (selectedSessionRef.current && selectedSessionRef.current.id === session.id) {
      applySessionHistory(history);
    }
  };

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
  const loadProjects = async (options: { selectSessionId?: string; selectProjectPath?: string } = {}) => {
    setLoadingProjects(true);
    try {
      const filtered = await fetchProjects();
      setProjects(filtered);
      if (filtered.length > 0 && expandedProjects.size === 0) {
        setExpandedProjects(new Set([filtered[0].id]));
      }
      if (options.selectSessionId) {
        const matched = findProjectBySessionId(filtered, options.selectSessionId);
        if (matched) {
          setSelectedProject(matched.project);
          setSelectedSession(matched.session);
          return;
        }
      }
      if (options.selectProjectPath) {
        const project = filtered.find((item) => item.path === options.selectProjectPath) || null;
        setSelectedProject(project);
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
    selectedSessionRef.current = selectedSession;
  }, [selectedSession]);

  useEffect(() => {
    return () => {
      streamAbortRef.current?.abort();
    };
  }, []);

  const selectedProjectRef = (items: AggregatedProject[], projectPath?: string) =>
    items.find((project) => project.path === projectPath) || null;

  useEffect(() => {
    if (!selectedSession) return;
    streamAbortRef.current?.abort();
    if (selectedSession.draft) {
      setMessages([]);
      setAllMessages([]);
      setHasMoreHistory(false);
      setLoading(false);
      return;
    }

    const loadMessages = async () => {
      setMessages([]);
      setAllMessages([]);
      setHasMoreHistory(false);
      setLoading(true);
      try {
        const history = await sessionsAPI.getSessionMessages(
          selectedSession.provider,
          selectedSession.id,
          selectedSession.projectDirName
        );
        if (selectedSessionRef.current && selectedSessionRef.current.id === selectedSession.id) {
          applySessionHistory(history);
        }

        if (!selectedAccount || selectedAccount.provider !== selectedSession.provider) {
          const match = accounts.find(a => a.provider === selectedSession.provider);
          if (match) setSelectedAccount(match);
        }
        const ownerProject = selectedProjectRef(projects, selectedSession.projectPath);
        if (ownerProject) setSelectedProject(ownerProject);
      } catch {
        message.error('加载会话历史失败');
      } finally {
        setLoading(false);
      }
    };

    loadMessages();

    // SSE 实时监听会话文件变更（原生会话）
    if (selectedSession.id) {
      const params = new URLSearchParams();
      params.set('sessionId', selectedSession.id);
      params.set('provider', selectedSession.provider);
      if (selectedSession.projectDirName) {
        params.set('projectDirName', selectedSession.projectDirName);
      }
      const es = new EventSource(`/v0/webui/sessions/watch?${params}`);
      es.onmessage = (evt) => {
        try {
          const data = JSON.parse(evt.data);
          if (data.type === 'update') {
            // 会话文件有更新，重新加载消息
            sessionsAPI.getSessionMessages(
              selectedSession.provider,
              selectedSession.id,
              selectedSession.projectDirName
            ).then(applySessionHistory).catch(() => {});
          }
        } catch {}
      };
      return () => es.close();
    }
  }, [selectedSession]);

  const handleSelectProject = (project: AggregatedProject) => {
    setSelectedProject(project);
    if (selectedSession && selectedSession.projectPath !== project.path) {
      setSelectedSession(null);
      setMessages([]);
      setAllMessages([]);
      setHasMoreHistory(false);
    }
  };

  const handleSelectSession = (session: Session) => {
    setSelectedSession(session);
    const ownerProject = projects.find((project) => project.path === session.projectPath) || null;
    if (ownerProject) setSelectedProject(ownerProject);
  };

  const handleCreateSession = () => {
    const targetProject = selectedProject;
    const defaultAccount = selectedAccount || accounts[0] || null;
    if (!targetProject) {
      message.warning('请先选择一个项目');
      return;
    }
    if (!defaultAccount) {
      message.warning('请先配置可用账号');
      return;
    }

    const draftSession: Session = {
      id: `draft-${Date.now()}`,
      title: '新会话',
      updatedAt: Date.now(),
      provider: defaultAccount.provider,
      projectPath: targetProject.path,
      draft: true
    };
    setSelectedSession(draftSession);
    setSelectedAccount(defaultAccount);
    setMessages([]);
    setAllMessages([]);
    setHasMoreHistory(false);
    setInput('');
  };

  const handlePickProject = async () => {
    setPickingProject(true);
    try {
      const result = await sessionsAPI.pickProjectDirectory();
      if (result.cancelled) return;
      if (result.project?.path) {
        setOpenProjectPath(result.project.path);
      }
      if (result.project?.name && !openProjectName.trim()) {
        setOpenProjectName(result.project.name);
      }
    } catch (error: any) {
      message.error(error?.response?.data?.message || error?.message || '无法打开目录选择器');
    } finally {
      setPickingProject(false);
    }
  };

  const handleOpenProject = async () => {
    const projectPath = openProjectPath.trim();
    const projectName = openProjectName.trim();
    if (!projectPath) {
      message.warning('请输入项目路径');
      return;
    }
    try {
      const project = await sessionsAPI.openProject(projectPath, projectName || undefined);
      setOpenProjectVisible(false);
      setOpenProjectPath('');
      setOpenProjectName('');
      await loadProjects({ selectProjectPath: project.path });
      setExpandedProjects((current) => new Set([...current, project.id]));
      setSelectedSession(null);
      message.success('项目已打开');
    } catch (error: any) {
      message.error(error?.response?.data?.message || error?.message || '打开项目失败');
    }
  };

  // 发送消息
  const handleSend = async () => {
    if (loading) return;
    if (!input.trim()) return message.warning('请输入消息');
    if (!selectedAccount) return message.warning('请先选择一个账号');
    if (!selectedSession) return message.warning('请先选择一个会话');
    if (!selectedSession.draft && selectedAccount.provider !== selectedSession.provider) {
      return message.error(`当前会话来自 ${providerNames[selectedSession.provider]}，请选择对应的账号`);
    }

    const requestSession = selectedSession;
    const requestProjectPath = selectedProject?.path || requestSession.projectPath;
    if (!requestProjectPath) {
      return message.error('当前会话缺少项目路径');
    }
    const userMsg: ChatMessage = {
      role: 'user',
      content: input.trim(),
      images: images.slice()
    };
    const requestMessages = [...messages, userMsg].map((message) => ({
      role: message.role,
      content: message.content
    }));
    const assistantPlaceholder: ChatMessage = { role: 'assistant', content: '', pending: true };
    const newMessages = [...requestMessages, assistantPlaceholder];
    setMessages(newMessages);
    setInput('');
    setImages([]);
    setLoading(true);
    const controller = new AbortController();
    streamAbortRef.current = controller;
    let usedNativeSession = false;

    try {
      let createdSessionId = '';
      const handleStreamEvent = (event: ChatStreamEvent) => {
        if (event.mode === 'native-session') {
          usedNativeSession = true;
        }
        if (event.type === 'ready' && event.runId) {
          return;
        }
        if (event.type === 'session-created' && event.sessionId) {
          createdSessionId = event.sessionId;
          return;
        }
        if (event.type === 'terminal-output' && event.text) {
          setMessages((current) => {
            const next = current.slice();
            const chunk = event.text || '';
            if (!chunk) return next;
            const last = next[next.length - 1];
            if (!last || last.role !== 'assistant') {
              next.push({ role: 'assistant', content: chunk, pending: false });
              return next;
            }
            next[next.length - 1] = {
              ...last,
              content: `${last.content || ''}${chunk}`,
              pending: false
            };
            return next;
          });
          return;
        }
        if (event.type === 'delta') {
          setMessages((current) => {
            const next = current.slice();
            const last = next[next.length - 1];
            if (!last || last.role !== 'assistant') {
              next.push({ role: 'assistant', content: event.delta || '', pending: false });
              return next;
            }
            next[next.length - 1] = {
              ...last,
              content: `${last.content || ''}${event.delta || ''}`,
              pending: false
            };
            return next;
          });
          return;
        }

        if (event.type === 'result' || event.type === 'done') {
          if (typeof event.content === 'string' && event.content) {
            const finalContent = event.content;
            setMessages((current) => {
              const next = current.slice();
              const last = next[next.length - 1];
              if (!last || last.role !== 'assistant') {
                next.push({ role: 'assistant', content: finalContent, pending: false });
                return next;
              }
              next[next.length - 1] = {
                ...last,
                content: finalContent,
                pending: false
              };
              return next;
            });
          }
          if (event.type === 'done') {
          }
        }
      };

      await chatAPI.sendStream({
        messages: requestMessages,
        prompt: userMsg.content,
        provider: selectedAccount.provider,
        accountId: selectedAccount.accountId,
        createSession: Boolean(requestSession.draft),
        sessionId: requestSession.draft ? undefined : requestSession.id,
        projectDirName: requestSession.draft ? undefined : requestSession.projectDirName,
        projectPath: requestProjectPath,
        model: selectedModel || undefined,
        images,
        stream: true
      }, {
        signal: controller.signal,
        onEvent: handleStreamEvent
      });
      if (requestSession.draft) {
        if (createdSessionId) {
          await loadProjects({
            selectSessionId: createdSessionId,
            selectProjectPath: requestProjectPath
          });
        } else if (usedNativeSession) {
          await loadProjects({
            selectProjectPath: requestProjectPath
          });
        }
      } else {
        if (usedNativeSession) {
          await reloadSessionHistory(requestSession);
        }
      }
    } catch (err: any) {
      dropPendingAssistantPlaceholder();
      if (err?.name === 'AbortError') {
        message.info('已停止生成');
      } else {
        message.error(err?.response?.data?.error || err?.response?.data?.message || err?.message || '发送失败');
      }
      await (requestSession.draft
        ? loadProjects({ selectProjectPath: requestProjectPath })
        : reloadSessionHistory(requestSession)
      ).catch(() => {});
    } finally {
      if (streamAbortRef.current === controller) {
        streamAbortRef.current = null;
      }
      setLoading(false);
    }
  };

  const handleStop = () => {
    streamAbortRef.current?.abort();
    dropPendingAssistantPlaceholder();
  };

  const toggleProject = (id: string) => {
    const next = new Set(expandedProjects);
    next.has(id) ? next.delete(id) : next.add(id);
    setExpandedProjects(next);
  };

  const displayProjects = (() => {
    if (!selectedSession?.draft || !selectedProject) return projects;
    return projects.map((project) => {
      if (project.path !== selectedProject.path) return project;
      return {
        ...project,
        sessions: [selectedSession, ...project.sessions.filter((session) => session.id !== selectedSession.id)]
      };
    });
  })();

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
          projects={displayProjects}
          loading={loadingProjects}
          selectedSession={selectedSession}
          selectedProject={selectedProject}
          expandedProjects={expandedProjects}
          onRefresh={loadProjects}
          onToggleProject={toggleProject}
          onSelectProject={handleSelectProject}
          onSelectSession={handleSelectSession}
          onOpenProject={() => setOpenProjectVisible(true)}
          onCreateSession={handleCreateSession}
          onProjectRemoved={(project) => {
            if (selectedProject?.path === project.path) {
              setSelectedProject(null);
            }
            if (selectedSession?.projectPath === project.path) {
              setSelectedSession(null);
              setMessages([]);
              setAllMessages([]);
              setHasMoreHistory(false);
            }
          }}
        />
      </Sider>

      <Content style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
        {selectedSession ? (
          <MessageArea
            session={selectedSession}
            messages={messages}
            accounts={accounts}
            selectedAccount={selectedAccount}
            selectedModel={selectedModel}
            input={input}
            loading={loading}
            hasMoreHistory={hasMoreHistory}
            images={images}
            onLoadMore={loadMoreHistory}
            onInputChange={setInput}
            onSend={handleSend}
            onStop={handleStop}
            onAccountChange={(account) => {
              setSelectedAccount(account);
              if (selectedSession.draft) {
                setSelectedSession({
                  ...selectedSession,
                  provider: account.provider
                });
              }
            }}
            onModelChange={setSelectedModel}
            onImagesChange={setImages}
          />
        ) : selectedProject ? (
          <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#fafafa' }}>
            <Empty
              description={`项目：${selectedProject.path}`}
              image={Empty.PRESENTED_IMAGE_SIMPLE}
            >
              <Button type="primary" icon={<PlusOutlined />} onClick={handleCreateSession}>
                新建会话
              </Button>
            </Empty>
          </div>
        ) : (
          <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#fafafa' }}>
            <Empty
              description="先打开一个项目，或选择左侧已有会话"
              image={Empty.PRESENTED_IMAGE_SIMPLE}
            >
              <Button type="primary" icon={<FolderOpenOutlined />} onClick={() => setOpenProjectVisible(true)}>
                打开项目
              </Button>
            </Empty>
          </div>
        )}
      </Content>

      <Modal
        title="打开项目"
        open={openProjectVisible}
        onOk={handleOpenProject}
        onCancel={() => setOpenProjectVisible(false)}
        okText="打开"
        cancelText="取消"
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Button onClick={handlePickProject} loading={pickingProject}>
            选择文件夹
          </Button>
          <Input
            placeholder="/absolute/path/to/project"
            value={openProjectPath}
            onChange={(e) => setOpenProjectPath(e.target.value)}
          />
          <Input
            placeholder="项目名称（可选）"
            value={openProjectName}
            onChange={(e) => setOpenProjectName(e.target.value)}
          />
        </div>
      </Modal>
    </Layout>
  );
};

export default Chat;
