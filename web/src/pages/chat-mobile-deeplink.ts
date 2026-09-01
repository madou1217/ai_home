import type { Session } from '@/types';
import type { PersistedChatSelection } from '@/features/legacy-chat/runtime-types';

/**
 * 移动端深链直达判定：初始选择（URL ?sessionId=… 或持久化恢复）带 sessionId，
 * 且恢复链路已选中真实会话（非草稿）时，移动端应直接进入详情屏。
 * 恢复链路只写 selectedSession、不经过 handleSelectSession，
 * 缺少这一步移动端会一直停在列表屏。
 */
export function shouldMobileDeepLinkEnterChat(
  initialSelection: PersistedChatSelection,
  selectedSession: Session | null,
): boolean {
  return Boolean(initialSelection.sessionId && selectedSession && !selectedSession.draft);
}
