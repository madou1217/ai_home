import {
  LegacyChatAccountCatalogClient,
  type LegacyChatAccountCatalogWatchHandlers,
} from './legacy-chat-account-catalog-core';
import {
  fetchAuthorizedWebUiResource,
  guardedWebUiEventSource,
} from './webui-auth-transport';

export type { LegacyChatAccountCatalogWatchHandlers };

// 聊天 Hook 只依赖账号目录读取；正式账号写入仍由当前 Node Accounts 页面负责。
export const legacyChatAccountCatalogAPI = new LegacyChatAccountCatalogClient({
  fetch: fetchAuthorizedWebUiResource,
  openStream: guardedWebUiEventSource,
});
