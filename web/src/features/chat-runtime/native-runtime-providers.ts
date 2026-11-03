import type { Session } from '@/types';

// 原生会话 provider 名单：与后端 lib/server/native-session-chat-utils.js 的
// OFFICIAL_NATIVE_SESSION_PROVIDERS 一致（canonical 服务端驱动按它注册，
// chat-runtime-composition.nativeSessionProviderRegistrations）。新增 provider 两处同步。
export const NATIVE_RUNTIME_PROVIDERS = Object.freeze([
  'codex',
  'claude',
  'gemini',
  'agy',
  'opencode',
  'grok',
  'zcode',
  'qoder',
  'qodercn',
  'cline',
  'codebuddy',
  'codebuddycn',
  'workbuddy',
  'workbuddycn',
] as const);

// API Key 账号能直接跑原生 CLI 的 provider：与后端 chat-runner-profile 的 apiKeyNativeReady 同源
// （codex：config-sync 生成 model_providers；claude：ANTHROPIC_* 注入；gemini：GOOGLE_* 映射 +
// ACP 显式认证）。其余 provider 的 API Key 账号没有原生凭据注入，legacy 也是走无状态代理而非原生会话。
export const API_KEY_NATIVE_READY_PROVIDERS: ReadonlySet<string> = new Set(['codex', 'claude', 'gemini']);

const NATIVE_RUNTIME_PROVIDER_SET: ReadonlySet<string> = new Set(NATIVE_RUNTIME_PROVIDERS);

/**
 * 判定一个已有原生会话能否从 WebUI 续写。返回 null 表示可写；返回字符串为禁用原因。
 *
 * 不在名单里的 provider（如 kimi/kiro），其会话在 WebUI 里只是只读历史：输入框发的消息会落到
 * 无状态推理端点（OAuth 报错 / 密钥账号得到「刷新即消失」的幽灵回复），所以禁用并写明原因。
 * （由 legacy-chat/native-session-write-policy 迁入：canonical 也必须有同样的只读保护。）
 */
export function resolveNativeSessionWriteBlock(session: Session | null | undefined): string | null {
  if (!session || session.draft) return null;
  const provider = String(session.provider || '').trim().toLowerCase();
  if (!provider) return null;
  if (NATIVE_RUNTIME_PROVIDER_SET.has(provider)) return null;
  return '该会话由原生客户端创建，WebUI 仅支持查看历史记录；续聊请使用对应的原生客户端，或在左侧新建会话。';
}
