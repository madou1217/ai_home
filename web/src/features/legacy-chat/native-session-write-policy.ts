import type { Session } from '@/types';

// 与后端 lib/server/native-session-chat-utils.js 的 OFFICIAL_NATIVE_SESSION_PROVIDERS
// 保持一致（2026-10-06 对齐快照）：只有这批 provider 的「原生会话」能被服务端续写。
// 不要改用 chatRuntimeProviders——那会让 claude/agy/opencode 等合法原生会话被误禁。
// 后端集合变更时必须同步本表（两处都以测试钉住：后端 native-session-chat-command、
// 前端 native-session-write-policy.test.ts）。
const NATIVE_SESSION_WRITABLE_PROVIDERS: ReadonlySet<string> = new Set([
  'codex',
  'claude',
  'gemini',
  'agy',
  'opencode',
  'grok',
  'qoder',
  'qodercn',
  'codebuddy',
  'codebuddycn',
  'workbuddy',
  'workbuddycn'
]);

/**
 * 判定一个已有原生会话能否从 WebUI 续写。返回 null 表示可写；
 * 返回字符串为禁用原因（直接展示给用户）。
 *
 * 背景：不在可续写集合里的 provider（如 zcode/kimi/kiro），其会话在 WebUI
 * 里只是只读历史视图。此时输入框发的消息会落到无状态推理端点——OAuth 账号
 * 直接报错，密钥账号会得到一轮「刷新即消失」的幽灵回复（不会被写回原生
 * 会话库）。因此禁用输入框并给出明确原因，而不是让用户误以为续聊成功。
 */
export function resolveNativeSessionWriteBlock(session: Session | null | undefined): string | null {
  if (!session || session.draft) return null;
  const provider = String(session.provider || '').trim().toLowerCase();
  if (!provider) return null;
  if (NATIVE_SESSION_WRITABLE_PROVIDERS.has(provider)) return null;
  return '该会话由原生客户端创建，WebUI 仅支持查看历史记录；续聊请使用对应的原生客户端，或在左侧新建会话。';
}
