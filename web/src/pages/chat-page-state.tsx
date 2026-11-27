import { useCallback, useEffect, useRef, useState } from 'react';
import { message } from 'antd';
import { history, useLocation } from '@umijs/max';
import type { WorkspaceMode } from '@/components/chat/ModeSelector';
import { resolveAppRoutePathname } from '@/services/app-navigation';
import ChatEmptyState from '@/components/chat/ChatEmptyState';
import { isSessionRunning } from '@/components/chat/project-runtime-state.js';
import { isSharedNativeSession } from '@/components/chat/session-provider-policy.js';
import type { AggregatedProject, Session } from '@/types';
import {
  CanonicalChatRuntime,
  resolveCanonicalSessionDirectoryFocus,
  resolveChatAccountChange,
  useCanonicalSessionDirectory,
  useCanonicalSessionRestore,
  useSessionApprovalMode,
} from '@/features/chat-runtime';
import ChatRuntimeBoundary from '@/features/chat-runtime/ChatRuntimeBoundary';
import ProjectWorkbench from '@/features/project-workbench/ProjectWorkbench';
import type { WorkbenchWorkspaceDescriptor } from '@/features/project-workbench/workbench-types';
import { resolveActiveServer } from '@/services/webui-auth-transport';
import { resolveWorkbenchSessions } from '@/features/project-workbench/workbench-sessions';
import ChatRuntimeFallback from '@/features/chat-runtime/ChatRuntimeFallback';
import { useChatAccountCatalog } from '@/features/chat-workspace/use-chat-account-catalog';
import { chatAccountIdentity } from '@/components/chat/aih-server-account';
import { useProjectDialogs } from '@/features/chat-workspace/use-project-dialogs';
import { useProjectCatalog } from '@/features/chat-workspace/use-project-catalog';
import type { PersistedChatSelection } from '@/features/chat-workspace/runtime-types';
import { carryComposerDraftToNextSession } from '@/features/chat-runtime/composer-draft-store';
import {
  readPersistedSelection,
} from './chat-selection-state.js';
import { shouldMobileDeepLinkEnterChat } from './chat-mobile-deeplink';
import {
  useChatSessionRestore,
  useMobileChatNavigation,
  useMobileImmersiveMode,
  usePersistedChatSelection,
} from './chat-page-hooks';

const STORAGE_KEY_CHAT_MODE = 'aih_chat_workspace_mode';
const STORAGE_KEY_WORK_SCOPE = 'aih_chat_work_scope';

export type WorkScope = 'local' | 'remote';

const CHAT_ROUTE_PATH = '/chat';
// Work 必须是独立顶级路径：/chat/work 会被 getMatchMenu 的 '/chat/(.*)' 同时命中，
// 侧栏 Chat 与 Work 双高亮（见 config/routes.ts 注释）。
const WORK_ROUTE_PATH = '/work';
/** 历史链接：旧 /chat/work 由 ChatWorkRedirect 跳到这里，模式判定仍按 work 处理。 */
const LEGACY_WORK_ROUTE_PATH = '/chat/work';

/**
 * 桌面主站把模式映射到菜单子路由：/chat = chat、/work = work。
 * 快捷小窗（launchMode / urlSelectionOnly）与移动端没有主站路由语义，返回 null 保持原行为。
 */
function modeFromPathname(pathname: string | undefined): WorkspaceMode | null {
  if (!pathname) return null;
  const normalized = resolveAppRoutePathname(pathname);
  if (normalized === WORK_ROUTE_PATH || normalized === LEGACY_WORK_ROUTE_PATH) return 'work';
  if (normalized === CHAT_ROUTE_PATH) return 'chat';
  return null;
}

function resolveExplicitRouteMode(): WorkspaceMode | null {
  if (typeof window === 'undefined') return null;
  return modeFromPathname(window.location.pathname);
}

/**
 * AI 会话页的页面级状态（项目/会话目录、账号、模型、审批模式、移动端两屏导航与全部处理函数）。
 * 桌面 Chat.tsx 与移动端 MobileChat 共用同一份逻辑；`mobile` 只影响原有的移动端分支
 * （进入对话屏、沉浸态、深链直达），桌面传入的值与原先一致。
 */
export function useChatPageState(
  mobile: boolean,
  launchMode?: WorkspaceMode,
  options: { readonly urlSelectionOnly?: boolean } = {},
) {
  // 桌面主站由路由决定模式；快捷小窗与移动端继续走 localStorage / 会话 projectPath 的既有逻辑。
  const routeDrivenMode = !mobile && !launchMode && !options.urlSelectionOnly;
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>(() => {
    // 快捷唤起指定了模式：本次打开用它，但不写回偏好（不改用户在主窗口的习惯）。
    if (launchMode) return launchMode;
    if (typeof window !== 'undefined') {
      if (routeDrivenMode) {
        // 菜单子路由 /work 进 Work、/chat 进 Chat（路由是模式的主要来源）。
        // 深链带 projectPath（如 SSH 开发机「在 Work 中打开」）仍优先进 Work。
        if (new URLSearchParams(window.location.search).get('projectPath')) return 'work';
        return resolveExplicitRouteMode() || 'chat';
      }
      // 移动端 / 快捷小窗没有主站路由语义，沿用原有 pathname + localStorage 行为。
      if (resolveAppRoutePathname(window.location.pathname) === WORK_ROUTE_PATH) return 'work';
      if (new URLSearchParams(window.location.search).get('projectPath')) return 'work';
      return (window.localStorage.getItem(STORAGE_KEY_CHAT_MODE) as WorkspaceMode) || 'chat';
    }
    return 'chat';
  });

  const handleModeChange = useCallback((newMode: WorkspaceMode) => {
    setWorkspaceMode(newMode);
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(STORAGE_KEY_CHAT_MODE, newMode);
    // 桌面主站把模式映射到菜单子路由，保持侧栏菜单高亮与地址一致；
    // 快捷小窗（独立外壳）与移动端 HUD 不参与主站路由。
    if (!mobile && !launchMode && !options.urlSelectionOnly) {
      const pathname = newMode === 'work' ? WORK_ROUTE_PATH : CHAT_ROUTE_PATH;
      if (resolveAppRoutePathname(history.location.pathname) !== pathname) {
        history.replace({ pathname, search: history.location.search });
      }
    }
  }, [mobile, launchMode, options.urlSelectionOnly]);

  // /chat 与 /work 渲染同一个 Chat 组件，菜单跳转不会重新挂载，useState 初值也不会重跑。
  // 只订阅 location 才能把路由变化同步成 workspaceMode；否则点菜单后页面仍停在旧模式，
  // 表现为 chat / work 没有真正分离。
  const location = useLocation();
  const locationMode = routeDrivenMode ? modeFromPathname(location?.pathname) : null;
  useEffect(() => {
    if (!locationMode) return;
    // 深链 /chat?projectPath=... 仍应进 Work：把地址补成 /work，保持 UI 与 URL 一致。
    if (locationMode === 'chat' && new URLSearchParams(location.search).get('projectPath')) {
      history.replace({ pathname: WORK_ROUTE_PATH, search: location.search });
      return;
    }
    setWorkspaceMode(locationMode);
  }, [locationMode, location?.search]);

  const [workScope, setWorkScope] = useState<WorkScope>(() => {
    if (typeof window === 'undefined') return 'local';
    return window.localStorage.getItem(STORAGE_KEY_WORK_SCOPE) === 'remote' ? 'remote' : 'local';
  });

  const handleWorkScopeChange = useCallback((scope: WorkScope) => {
    setWorkScope(scope);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(STORAGE_KEY_WORK_SCOPE, scope);
    }
  }, []);

  // 快捷窗口只认 URL 里显式指定的会话：不继承主窗口上次停留的会话（那可能是别的工作区里正在跑的长会话）。
  const initialSelectionRef = useRef<PersistedChatSelection>(
    options.urlSelectionOnly ? readUrlSelection() : readPersistedSelection(),
  );
  const projectCatalog = useProjectCatalog(initialSelectionRef.current);
  // 「选中工作区会话 → Work」的业务语义要保留，但不能让它覆盖路由显式进入的模式：
  // 从 /work 进入时，若恢复出的是上次的纯聊天会话，原 effect 会立刻
  // handleModeChange('chat') 把 URL replace 回 /chat，表现为点 Work 后弹回 Chat。
  // 用 ref 跳过首次（含异步恢复）的会话回写；之后用户主动点选会话仍照常切模式。
  const initialRouteModeRef = useRef(routeDrivenMode ? resolveExplicitRouteMode() : null);
  const initialSessionKeyRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    // 桌面主站的模式由路由决定（/chat vs /work），会话恢复不能反向改写路由，
    // 否则在 Work 恢复出上次的纯聊天会话时会被弹回 Chat。
    if (routeDrivenMode) return;
    const session = projectCatalog.selectedSession;
    if (!session) return;
    const key = `${session.id || ''}:${session.projectPath || ''}`;
    if (!initialSessionKeyRef.current) initialSessionKeyRef.current = key;
    // 同一个会话重复触发（异步恢复 / StrictMode 二次执行）也不覆盖路由模式。
    if (initialRouteModeRef.current && key === initialSessionKeyRef.current) return;
    handleModeChange(session.projectPath ? 'work' : 'chat');
  }, [projectCatalog.selectedSession?.id, projectCatalog.selectedSession?.projectPath, handleModeChange]);
  const canonicalDirectory = useCanonicalSessionDirectory(
    projectCatalog.displayProjects,
    resolveCanonicalSessionDirectoryFocus(projectCatalog.selectedSession, {
      provider: initialSelectionRef.current.provider,
      projectPath: initialSelectionRef.current.projectPath,
      nativeSessionId: initialSelectionRef.current.sessionId,
    }),
    undefined,
    { catalogLoading: projectCatalog.loadingProjects },
  );
  const accountCatalog = useChatAccountCatalog(
    projectCatalog.selectedSession?.provider,
    projectCatalog.selectedSession?.accountRef,
    isSharedNativeSession(projectCatalog.selectedSession),
  );
  const [selectedModel, setSelectedModel] = useState('');
  const [mobileShowChat, setMobileShowChat] = useState(false);
  const cancelCanonicalRestore = useCanonicalSessionRestore({
    initialSelection: initialSelectionRef.current,
    ready: canonicalDirectory.ready,
    directoryProjects: canonicalDirectory.projects,
    catalogProjects: projectCatalog.projects,
    selectedSession: projectCatalog.selectedSession,
    setSelectedProject: projectCatalog.setSelectedProject,
    setSelectedSession: projectCatalog.setSelectedSession,
    setExpandedProjects: projectCatalog.setExpandedProjects,
  });
  const dialogs = useProjectDialogs({
    mobile,
    loadProjects: projectCatalog.loadProjects,
    setExpandedProjects: projectCatalog.setExpandedProjects,
    setSelectedSession: projectCatalog.setSelectedSession,
    setMobileShowChat,
    onSelectionMutation: cancelCanonicalRestore,
  });
  const approvalMode = useSessionApprovalMode(projectCatalog.selectedSession);
  const refreshSessionDirectory = useCallback(async (
    selection: PersistedChatSelection = {},
  ): Promise<void> => {
    await Promise.all([
      projectCatalog.loadProjects(selection),
      canonicalDirectory.refresh(),
    ]);
  }, [canonicalDirectory.refresh, projectCatalog.loadProjects]);
  const refreshProjectList = useCallback((): void => {
    void refreshSessionDirectory();
  }, [refreshSessionDirectory]);
  // 远程工作区「在 Work 中打开」：它在项目目录里以影子目录为路径，按该路径刷新并选中。
  const handleOpenRemoteWorkspace = useCallback(async (workspace: { projectPath?: string }): Promise<void> => {
    const projectPath = String(workspace.projectPath || '');
    if (!projectPath) return;
    handleModeChange('work');
    const existing = projectCatalog.projects.find((project) => project.path === projectPath);
    if (existing) {
      projectCatalog.setSelectedProject(existing);
      projectCatalog.setExpandedProjects((current) => new Set([...current, existing.id]));
      return;
    }
    await refreshSessionDirectory({ projectPath });
  }, [handleModeChange, projectCatalog, refreshSessionDirectory]);

  useMobileImmersiveMode(mobile, mobileShowChat);
  usePersistedChatSelection(projectCatalog.selectedProject, projectCatalog.selectedSession, workspaceMode === 'chat');
  // chat 模式会话(无 projectPath)不在 canonical/project 目录里,需单独从 chat-sessions 恢复
  useChatSessionRestore({
    initialSelection: initialSelectionRef.current,
    selectedSession: projectCatalog.selectedSession,
    setSelectedSession: projectCatalog.setSelectedSession,
  });
  useEffect(() => {
    if (!mobile) return;
    if (!projectCatalog.selectedProject && !projectCatalog.selectedSession) {
      setMobileShowChat(false);
    }
  }, [mobile, projectCatalog.projects.length, projectCatalog.selectedProject, projectCatalog.selectedSession]);

  // 移动端深链直达：URL/持久化恢复的会话不经过 handleSelectSession，
  // mobileShowChat 停在 false 会一直停在列表屏，恢复命中后补一次进详情屏。
  const mobileDeepLinkRef = useRef(false);
  useEffect(() => {
    if (!mobile || mobileDeepLinkRef.current) return;
    if (!shouldMobileDeepLinkEnterChat(initialSelectionRef.current, projectCatalog.selectedSession)) return;
    mobileDeepLinkRef.current = true;
    setMobileShowChat(true);
  }, [mobile, projectCatalog.selectedSession]);

  const handleSelectProject = useCallback((project: AggregatedProject): void => {
    cancelCanonicalRestore();
    projectCatalog.setSelectedProject(project);
    projectCatalog.hydrateProjectSessions(project.path, { projectPath: project.path }).catch(() => {});
    if (projectCatalog.selectedSession?.projectPath !== project.path) {
      projectCatalog.setSelectedSession(null);
    }
  }, [cancelCanonicalRestore, projectCatalog]);
  const handleSelectSession = useCallback((session: Session): void => {
    cancelCanonicalRestore();
    projectCatalog.setSelectedSession(session);
    const owner = projectCatalog.projects.find((project) => project.path === session.projectPath);
    if (owner) {
      projectCatalog.setSelectedProject(owner);
      projectCatalog.setExpandedProjects((current) => new Set([...current, owner.id]));
    }
    if (mobile) setMobileShowChat(true);
  }, [cancelCanonicalRestore, mobile, projectCatalog]);

  const handleCreateSession = useCallback((): void => {
    const account = accountCatalog.selectedAccount || accountCatalog.accounts[0] || null;
    cancelCanonicalRestore();
    if (!account) {
      if (accountCatalog.loadFailed) {
        message.error('远端账号尚未加载成功（连接异常），请点刷新重试，不是缺少账号配置');
      } else {
        message.warning('请先配置可用账号');
      }
      return;
    }

    if (workspaceMode === 'chat') {
      // 纯聊天模式：不需要 projectPath
      projectCatalog.setSelectedSession({
        id: `draft-${Date.now()}`,
        title: '新对话',
        updatedAt: Date.now(),
        provider: account.provider,
        draft: true,
      });
      accountCatalog.setSelectedAccount(account);
      if (mobile) setMobileShowChat(true);
      return;
    }

    // Work 模式：需要选择工作区项目
    const project = projectCatalog.selectedProject;
    if (!project) {
      message.warning('请先选择一个项目');
      return;
    }

    projectCatalog.setSelectedSession({
      id: `draft-${Date.now()}`,
      title: '新会话',
      updatedAt: Date.now(),
      provider: account.provider,
      projectPath: project.path,
      draft: true,
    });
    accountCatalog.setSelectedAccount(account);
    if (mobile) setMobileShowChat(true);
  }, [accountCatalog, cancelCanonicalRestore, mobile, projectCatalog, workspaceMode]);

  const handleProjectRemoved = useCallback((project: AggregatedProject): void => {
    cancelCanonicalRestore();
    if (projectCatalog.selectedProject?.path === project.path) {
      projectCatalog.setSelectedProject(null);
    }
    if (projectCatalog.selectedSession?.projectPath === project.path) {
      projectCatalog.setSelectedSession(null);
    }
  }, [cancelCanonicalRestore, projectCatalog]);

  const runningSessionKeys = projectCatalog.passiveRunningSessionKeys;
  const selectedSessionRunning = projectCatalog.selectedSession
    ? isSessionRunning(projectCatalog.selectedSession, runningSessionKeys)
    : false;
  const projectLabel = projectCatalog.selectedSession && !projectCatalog.selectedSession.projectPath
    ? 'AI 纯聊天'
    : (projectCatalog.selectedProject?.name || '项目会话');
  const navigation = useMobileChatNavigation(setMobileShowChat);

  return {
    mobile,
    workspaceMode,
    handleModeChange,
    workScope,
    handleWorkScopeChange,
    projectCatalog,
    canonicalDirectory,
    accountCatalog,
    selectedModel,
    setSelectedModel,
    mobileShowChat,
    setMobileShowChat,
    dialogs,
    approvalMode,
    refreshSessionDirectory,
    refreshProjectList,
    handleOpenRemoteWorkspace,
    handleSelectProject,
    handleSelectSession,
    handleCreateSession,
    handleProjectRemoved,
    runningSessionKeys,
    selectedSessionRunning,
    projectLabel,
    navigation,
  };
}

export type ChatPageState = ReturnType<typeof useChatPageState>;

function readUrlSelection(): PersistedChatSelection {
  if (typeof window === 'undefined') return {};
  const params = new URLSearchParams(window.location.search);
  const selection: PersistedChatSelection = {
    ...(params.get('projectPath') ? { projectPath: params.get('projectPath') || undefined } : {}),
    ...(params.get('sessionId') ? { sessionId: params.get('sessionId') || undefined } : {}),
    ...(params.get('provider') ? { provider: params.get('provider') || undefined } : {}),
    ...(params.get('projectDirName') ? { projectDirName: params.get('projectDirName') || undefined } : {}),
  };
  return selection;
}

/**
 * 对话运行时区域：ChatRuntimeBoundary 按会话选择 canonical / legacy / 空状态，
 * Work 模式外包 ProjectWorkbench（文件 / 终端 / Review 面板）。
 * `canonicalFrameClassName` 仅供移动端给 canonical 运行时补安全区外框；桌面不传，DOM 与原先一致。
 */
export function ChatConversationContent({
  state,
  canonicalFrameClassName,
  workbench = true,
  forceColumnsLayout = false,
}: {
  state: ChatPageState;
  canonicalFrameClassName?: string;
  /** work 模式是否外包项目工作台（文件 / Review）。快捷窗口窄宽度下关掉，只留会话。 */
  workbench?: boolean;
  /** 桌面原生快捷窗口跨单/双/三栏宽度缩放时固定走三栏宿主槽位，防止跨 600px/1000px 重建会话运行时。 */
  forceColumnsLayout?: boolean;
}) {
  const {
    mobile,
    workspaceMode,
    projectCatalog,
    canonicalDirectory,
    accountCatalog,
    selectedModel,
    setSelectedModel,
    dialogs,
    approvalMode,
    refreshSessionDirectory,
    handleSelectSession,
    handleCreateSession,
    runningSessionKeys,
    projectLabel,
  } = state;

  const runtimeContent = (
    <ChatRuntimeBoundary
      session={projectCatalog.selectedSession}
      account={accountCatalog.selectedAccount}
      canonical={(session) => {
        const canonical = (
          <CanonicalChatRuntime
            session={session}
            projectPath={!session.projectPath ? undefined : projectCatalog.selectedProject?.path}
            account={accountCatalog.selectedAccount}
            accounts={accountCatalog.accounts}
            title={session.title || projectLabel}
            mobile={mobile}
            selectedModel={selectedModel}
            approvalMode={approvalMode.mode}
            approvalModeReady={approvalMode.ready}
            onAccountChange={(account) => {
              const action = resolveChatAccountChange({
                projectPath: session.projectPath, provider: session.provider, accountRef: session.accountRef,
                draft: session.draft, runtimeSessionId: session.runtimeSessionId, account,
              });
              if (action === 'ignore') return;
              accountCatalog.setSelectedAccount(account);
              if (action === 'retarget') {
                // 同 provider 换账号 = 换执行凭据：会话与时间线不变，服务端 open 时会 rebind，
                // harness 换到新账号并用会话历史回填。
                projectCatalog.setSelectedSession({
                  ...session,
                  accountRef: chatAccountIdentity(account),
                  updatedAt: Date.now(),
                });
                return;
              }
              if (!session.projectPath) {
                // 跨 provider 换账号 = 新会话；用户已输入的内容跟着走。
                carryComposerDraftToNextSession();
                projectCatalog.setSelectedSession({
                  id: `draft-${Date.now()}`, title: '新对话', updatedAt: Date.now(),
                  provider: account.provider, draft: true,
                });
                setSelectedModel('');
                return;
              }
              // Work 草稿换到另一个 provider 的账号：按新 provider 重建草稿（项目不变），
              // 否则草稿仍是旧 provider，运行目标会被判成 provider_mismatch。
              if (session.draft && session.provider !== account.provider) {
                carryComposerDraftToNextSession();
                projectCatalog.setSelectedSession({
                  id: `draft-${Date.now()}`, title: session.title || '新会话', updatedAt: Date.now(),
                  provider: account.provider, projectPath: session.projectPath, draft: true,
                });
                setSelectedModel('');
              }
            }}
            onModelChange={setSelectedModel}
            onApprovalModeChange={approvalMode.change}
            onSessionChange={projectCatalog.setSelectedSession}
            onProjectsRefresh={refreshSessionDirectory}
          />
        );
        return canonicalFrameClassName
          ? <div className={canonicalFrameClassName}>{canonical}</div>
          : canonical;
      }}
      fallback={(session) => (
        <ChatRuntimeFallback session={session} account={accountCatalog.selectedAccount} mobile={mobile} />
      )}
      empty={() => (
        <ChatEmptyState
          mode={workspaceMode}
          projectPath={projectCatalog.selectedProject?.path}
          mobile={mobile}
          onCreateSession={handleCreateSession}
          onOpenProject={dialogs.openProject}
        />
      )}
    />
  );

  const chromeActive = workspaceMode === 'work' && workbench;
  const workbenchDescriptor = projectCatalog.selectedProject?.path ? (projectCatalog.selectedProject.remote ? {
    // 远程工作区：文件 / 变更 / 终端都落到 SSH 开发机（root 仍是影子目录 = 项目身份）。
    kind: 'ssh-workspace',
    serverId: resolveActiveServer().serverId || undefined,
    workspaceId: projectCatalog.selectedProject.remote.workspaceId,
    root: projectCatalog.selectedProject.path,
    remoteRoot: projectCatalog.selectedProject.remote.remoteRoot,
    label: `${projectCatalog.selectedProject.remote.host}:${projectCatalog.selectedProject.remote.remoteRoot}`,
  } : {
    kind: resolveActiveServer().isRemote ? 'remote-server' : 'local-server',
    serverId: resolveActiveServer().serverId || undefined,
    root: projectCatalog.selectedProject.path,
    label: resolveActiveServer().isRemote ? '远程 Server' : '本机 Server',
  }) satisfies WorkbenchWorkspaceDescriptor : undefined;

  // 独立移动端路由（带 canonicalFrameClassName）保持原有条件直出，零触碰移动端 DOM 结构。
  if (canonicalFrameClassName && !chromeActive) {
    return runtimeContent;
  }

  // 桌面主站与 QuickChat 统一稳定单树组合：Chat / Work 切换或小窗宽度档位变化时，
  // 仅开关 ProjectWorkbench 外围资源/工具栏（chromeActive），中心 runtimeContent 始终固定在同一 React Fiber 槽位，
  // 从而完整保留未发送附件（use-composer-attachments）、输入草稿、SSE 运行时订阅与输入框焦点身份。
  return (
    <ProjectWorkbench
      chromeActive={chromeActive}
      forceColumnsLayout={forceColumnsLayout}
      projectPath={projectCatalog.selectedProject?.path}
      workspace={workbenchDescriptor}
      mobile={mobile}
      chat={runtimeContent}
      sessions={resolveWorkbenchSessions(
        canonicalDirectory.projects,
        projectCatalog.selectedProject?.path,
      )}
      selectedSession={projectCatalog.selectedSession}
      runningSessionKeys={runningSessionKeys}
      onSelectSession={handleSelectSession}
    />
  );
}
