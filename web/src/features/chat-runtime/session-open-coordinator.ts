import type { ChatRuntimeApi, ChatRuntimeSession } from '@/chat-runtime';
import type { SessionRuntimeTarget } from './session-surface-policy';

// 会话「打开」的并发去重。
//
// 为什么需要：同一个目标的首帧打开可能被多个挂载点同时触发（桌面/移动布局、快捷
// 窗口、快速重挂）。服务器对带 chatSessionId 的打开是幂等的，但并发请求仍会打出
// 多条 POST，并各自拉起一条 SSE。这里按目标合并「在途」请求：同一时刻只让一条真正
// 到达服务器，请求结束（成功或失败）立刻释放，用户主动新建下一次照常新建。
//
// 只合并**在途**请求，不缓存结果：会话是可变对象，缓存命中会把「新开一个」变成
// 「复用上次的」，那是另一种错误。

/** 打开会话所需的最小 api 面（便于单测注入）。 */
export type SessionOpenApi = Pick<ChatRuntimeApi, 'createSession' | 'resolveSession'>;

export class SessionOpenCoordinator {
  private readonly inFlight = new Map<string, Promise<ChatRuntimeSession>>();

  /**
   * 取会话：有 sessionId/nativeSessionId 时按 id 解析，否则创建。
   * 相同 key 的并发调用共享同一个在途 Promise。
   */
  open(target: SessionRuntimeTarget, api: SessionOpenApi): Promise<ChatRuntimeSession> {
    const key = sessionOpenKey(target);
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const request = target.nativeSessionId || target.sessionId
      ? api.resolveSession(target).then((resolution) => resolution.session)
      : api.createSession(target);
    let shared: Promise<ChatRuntimeSession>;
    shared = request.finally(() => {
      if (this.inFlight.get(key) === shared) this.inFlight.delete(key);
    });
    this.inFlight.set(key, shared);
    return shared;
  }

  /** 当前在途请求数（诊断与测试用）。 */
  get pendingCount(): number {
    return this.inFlight.size;
  }
}

/** 页面级共享实例：所有挂载点共用同一张在途表。 */
export const sessionOpenCoordinator = new SessionOpenCoordinator();

function sessionOpenKey(target: SessionRuntimeTarget): string {
  return [
    target.provider,
    target.executionAccountRef,
    target.projectPath,
    target.sessionId || '',
    target.nativeSessionId || '',
    target.chatSessionId || '',
    target.readOnly ? 'readonly' : 'write'
  ].join('\u0000');
}
