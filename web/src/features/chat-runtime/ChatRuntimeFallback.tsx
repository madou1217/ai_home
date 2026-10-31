import type { ChatAccount, Session } from '@/types';
import ReadOnlyNativeHistory from './ReadOnlyNativeHistory';
import { resolveNativeSessionWriteBlock } from './native-runtime-providers';
import styles from './session-runtime.module.css';

// canonical 接不住的会话的唯一出口（legacy 聊天表面退役后）：
//   - 已有的原生会话、但 provider 没有原生运行时（kimi / kiro 等）→ 只读历史 + 原因；
//   - 草稿/会话缺少可用目标（没选项目、选中的账号形态跑不了该 provider 的原生 CLI）→ 明确提示怎么做。
// 不做无状态代理续聊：那会产生「刷新即消失」的幽灵轮次（legacy 时期的已知坑）。
export default function ChatRuntimeFallback({ session, account, mobile = false }: {
  readonly session: Session;
  readonly account: ChatAccount | null;
  readonly mobile?: boolean;
}) {
  const writeBlock = resolveNativeSessionWriteBlock(session);
  if (writeBlock && !session.draft) {
    return <ReadOnlyNativeHistory session={session} notice={writeBlock} mobile={mobile} />;
  }
  const reason = !session.projectPath && session.mode !== 'chat'
    ? '请先在左侧选择或打开一个项目，再开始原生会话。'
    : account?.apiKeyMode
      ? `${session.provider} 的原生 CLI 不能用 API Key 账号运行会话，请在输入框下方切换到该 provider 的登录账号。`
      : '请选择一个可用账号后再开始会话。';
  return (
    <main className={styles.workspace} data-runtime-workspace="true">
      <div className={styles.timeline}>
        <div className={styles.runtimeNotice} role="status">{reason}</div>
      </div>
    </main>
  );
}
