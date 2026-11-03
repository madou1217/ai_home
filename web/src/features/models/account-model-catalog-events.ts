/**
 * 账号模型目录变更事件（跨页面失效通知）。
 *
 * 为什么需要（2026-10-23 用户反馈「手动新增的模型 chat 里不显示」）：
 * chat 的模型列表按 `当前server + accountRef` 缓存（内存 Map + localStorage），
 * 打开会话时**先用缓存渲染、后台再刷新**。而账号模型页（/accounts/:provider/:accountRef/models）
 * 增删改模型后没有任何通知 —— chat 如果已经打开过该账号（或 localStorage 里有旧缓存），
 * 切回 chat 时 `selectedTargetKey` 没变、加载 effect 不重跑，就永远停在旧列表：
 * 用户新加的模型在账号页看得见、在 chat 里选不到。
 *
 * 用法：写方（账号模型页 / 移动端模型页）在保存成功后 dispatch；读方（chat）监听后
 * 丢掉该账号的缓存并重新拉取。事件不携带数据 —— 缓存失效比传值更不容易出错，
 * 读方本来就有一条完整的「拉取 → 覆盖缓存」路径。
 *
 * 细节：`accountRef` 为空表示「所有账号的目录都可能变了」（例如批量刷新），
 * 读方据此清空全部缓存。
 */
export const ACCOUNT_MODEL_CATALOG_CHANGED_EVENT = 'aih:account-model-catalog-changed';

export interface AccountModelCatalogChangedDetail {
  /** 受影响的账号；空串表示不确定/全部。 */
  readonly accountRef?: string;
}

/**
 * 事件总线所在的全局对象。浏览器里是 `window`；测试（bun test 无 DOM）可注入替身。
 * 拿不到任何可派发事件的对象时返回 null，两个 API 都退化成无操作 —— 缓存失效是
 * 体验优化，不该因为环境缺 DOM 而报错。
 */
type EventTargetLike = Pick<EventTarget, 'addEventListener' | 'removeEventListener' | 'dispatchEvent'>;

let eventTargetOverride: EventTargetLike | null = null;

function resolveEventTarget(): EventTargetLike | null {
  if (eventTargetOverride) return eventTargetOverride;
  return typeof window === 'undefined' ? null : window;
}

/** 测试用：替换事件目标；传 null 恢复默认（浏览器 window）。 */
export function setAccountModelCatalogEventTarget(target: EventTargetLike | null): void {
  eventTargetOverride = target;
}

/** 通知「这个账号的模型目录变了」。accountRef 省略时表示全部账号。 */
export function notifyAccountModelCatalogChanged(accountRef?: string): void {
  const target = resolveEventTarget();
  if (!target) return;
  const detail: AccountModelCatalogChangedDetail = {
    accountRef: String(accountRef || '').trim()
  };
  target.dispatchEvent(new CustomEvent(ACCOUNT_MODEL_CATALOG_CHANGED_EVENT, { detail }));
}

/**
 * 读方订阅。回调拿到受影响的 accountRef（空串 = 全部）。
 * 返回退订函数，调用方在 effect 清理里调用。
 */
export function onAccountModelCatalogChanged(
  handler: (accountRef: string) => void
): () => void {
  const target = resolveEventTarget();
  if (!target) return () => {};
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<AccountModelCatalogChangedDetail>).detail;
    handler(String(detail && detail.accountRef || '').trim());
  };
  target.addEventListener(ACCOUNT_MODEL_CATALOG_CHANGED_EVENT, listener);
  return () => target.removeEventListener(ACCOUNT_MODEL_CATALOG_CHANGED_EVENT, listener);
}
