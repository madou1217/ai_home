import { BrowserServerTransport } from '../server-transport/browser-adapter.ts';
import { AccountManagementClient } from './client.ts';
import { AccountManagementFacade } from './facade.ts';

const GO_ACCOUNTS_PREVIEW_PROFILE_ID = 'go-accounts-preview';

// Preview 固定回到当前独立 Web origin，再由开发代理转发到 Go 19527。
const previewTransport = new BrowserServerTransport({
  resolveProfile(profileId) {
    if (profileId !== GO_ACCOUNTS_PREVIEW_PROFILE_ID) {
      throw new Error('go_accounts_preview_profile_invalid');
    }
    if (typeof window === 'undefined' || !window.location?.origin) {
      throw new Error('go_accounts_preview_origin_missing');
    }
    return { endpoint: window.location.origin };
  },
});

function createPreviewClient(): Promise<AccountManagementClient> {
  return Promise.resolve(new AccountManagementClient({
    profileId: GO_ACCOUNTS_PREVIEW_PROFILE_ID,
    transport: previewTransport,
  }));
}

// accountsAPI 只被 AccountsGoPreview 路由加载，不读取正式 active Server Profile。
export const accountsAPI = new AccountManagementFacade({
  clientFactory: createPreviewClient,
});
