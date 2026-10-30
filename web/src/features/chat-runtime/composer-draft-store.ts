import { resolveActiveServer } from '@/services/webui-auth-transport';

const STORAGE_KEY = 'aih:composer-drafts:v1';
const MAX_DRAFTS = 80;
const CARRY_WINDOW_MS = 5000;

/**
 * 草稿归属 = 「这段输入是写给哪个会话的」。
 *
 * 账号与 provider 是**运行目标**，不是会话身份：同一会话换账号、草稿换 provider 时用户的
 * 输入不该丢。因此 key 只由 Server + 模式 + 会话（未绑定的新会话统一为 `new`）+ 项目目录组成；
 * 新会话在不同 provider 之间切换会生成新的 draft id，但都落在同一个 `new` 槽位上。
 */
export interface ComposerDraftIdentity {
  readonly sessionId?: string;
  /** 尚未绑定原生/运行时会话的新会话：所有 provider 共用同一个草稿槽位。 */
  readonly draft?: boolean;
  readonly workspaceMode?: string;
  readonly projectPath?: string;
}

let lastWrittenKey = '';
let pendingCarry: { readonly at: number } | null = null;

function draftKey(identity: ComposerDraftIdentity): string {
  const server = resolveActiveServer();
  return [
    server.serverId || 'local',
    server.isRemote ? 'remote' : 'same-origin',
    identity.workspaceMode || 'chat',
    identity.draft ? 'new' : (identity.sessionId || 'new'),
    identity.projectPath || '',
  ].map((part) => encodeURIComponent(String(part))).join('|');
}

function readAll(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}');
    if (!parsed || typeof parsed !== 'object') return {};
    return Object.fromEntries(Object.entries(parsed as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  } catch {
    return {};
  }
}

function writeAll(all: Record<string, string>): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(Object.entries(all).slice(-MAX_DRAFTS))));
}

/**
 * 读取草稿。若刚刚发生过「换 provider 导致换会话」（{@link carryComposerDraftToNextSession}），
 * 且目标槽位为空，就把上一个槽位里的输入搬过来 —— 输入跟着用户走，而不是留在旧会话里。
 *
 * 时序依赖 React 的提交顺序：旧槽位的 effect 清理（或卸载清理）会先把最新输入写入
 * `lastWrittenKey`，然后新槽位才执行读取。
 */
export function readComposerDraft(identity: ComposerDraftIdentity): string {
  const key = draftKey(identity);
  const all = readAll();
  const carry = pendingCarry;
  pendingCarry = null;
  const own = all[key] || '';
  if (own || !carry || Date.now() - carry.at > CARRY_WINDOW_MS) return own;
  const from = lastWrittenKey;
  const carried = from && from !== key ? all[from] || '' : '';
  if (!carried || typeof window === 'undefined') return own;
  try {
    all[key] = carried;
    delete all[from];
    writeAll(all);
    lastWrittenKey = key;
  } catch {
    // 存储失败时仍把内容交给输入框，至少当前页面不丢。
  }
  return carried;
}

export function writeComposerDraft(identity: ComposerDraftIdentity, value: string): void {
  if (typeof window === 'undefined') return;
  try {
    const key = draftKey(identity);
    const all = readAll();
    if (value) all[key] = value;
    else delete all[key];
    writeAll(all);
    lastWrittenKey = key;
  } catch {
    // Storage failures must never interrupt typing.
  }
}

export function clearComposerDraft(identity: ComposerDraftIdentity): void {
  writeComposerDraft(identity, '');
}

/**
 * 声明「接下来要切到另一个会话，但用户的输入应该跟过去」—— 用于跨 provider 切换账号时
 * 由页面新建草稿会话的那一刻。只影响紧接着的一次读取，且有时间窗兜底。
 */
export function carryComposerDraftToNextSession(): void {
  pendingCarry = { at: Date.now() };
}

export function composerDraftKey(identity: ComposerDraftIdentity): string {
  return draftKey(identity);
}
