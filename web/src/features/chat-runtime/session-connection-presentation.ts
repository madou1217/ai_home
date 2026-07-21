import type { SessionConnectionState } from '@/chat-runtime';

export interface SessionConnectionPresentation {
  readonly interactive: boolean;
  readonly label: string;
  readonly notice?: string;
}

export interface RuntimeFailurePresentation {
  readonly title: string;
  readonly description: string;
}

interface RuntimeFailureDiagnostic {
  readonly code: string;
  readonly message: string;
}

export function sessionConnectionPresentation(
  state: SessionConnectionState,
): SessionConnectionPresentation {
  return PRESENTATION_BY_STATE[state];
}

export function runtimeFailurePresentation(
  failure: RuntimeFailureDiagnostic,
): RuntimeFailurePresentation {
  return FAILURE_PRESENTATION_BY_CODE[failure.code] || DEFAULT_FAILURE_PRESENTATION;
}

const DEFAULT_FAILURE_PRESENTATION: RuntimeFailurePresentation = {
  title: 'AIH Chat Runtime 暂时不可用',
  description: '连接运行时失败，请稍后重试。',
};

const FAILURE_PRESENTATION_BY_CODE: Readonly<Record<string, RuntimeFailurePresentation>> = {
  chat_session_account_required: {
    title: 'AIH Server 需要刷新',
    description: '服务端仍在使用旧版会话协议，请重启 AIH Server 后重试。',
  },
  chat_session_execution_account_required: {
    title: '请选择运行凭据',
    description: '请选择当前 provider 可用的 OAuth 或 API Key 凭据。',
  },
  chat_execution_credential_change_conflict: {
    title: '当前会话正在运行',
    description: '请等待当前回复结束后再切换运行凭据。',
  },
  provider_runtime_not_found: {
    title: '未找到 provider CLI',
    description: '请确认当前 provider 的 CLI 已安装并可从 PATH 访问。',
  },
  provider_runtime_unhealthy: {
    title: 'Codex CLI 无法启动',
    description: 'PATH 默认的 Codex CLI 已损坏或不可执行，请修复默认安装后重试。',
  },
  chat_provider_driver_unavailable: {
    title: '当前 provider 尚不可用',
    description: 'AIH Chat Runtime 尚未注册该 provider 的原生驱动。',
  },
  codex_app_server_tmux_unavailable: {
    title: 'Codex 运行环境未就绪',
    description: '当前系统缺少可用的持久会话引擎，请完成环境配置后重试。',
  },
  codex_app_server_not_ready: {
    title: 'Codex Runtime 启动超时',
    description: 'Codex 原生运行时未能及时就绪，请重试。',
  },
  codex_app_server_process_exited: {
    title: 'Codex CLI 无法启动',
    description: 'PATH 默认的 Codex CLI 启动后立即退出，请修复默认安装后重试。',
  },
};

const PRESENTATION_BY_STATE: Readonly<
  Record<SessionConnectionState, SessionConnectionPresentation>
> = {
  connecting: {
    interactive: false,
    label: '正在连接',
    notice: '正在建立实时连接，连接完成前操作已暂停。',
  },
  connected: {
    interactive: true,
    label: '实时已连接',
  },
  reconnecting: {
    interactive: false,
    label: '正在重连',
    notice: '实时连接已中断，恢复前会话操作已暂停。',
  },
  resyncing: {
    interactive: false,
    label: '正在同步',
    notice: '会话状态可能已过期，重新同步完成前操作已暂停。',
  },
};
