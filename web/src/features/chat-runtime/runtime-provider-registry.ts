import type { Account, ChatAccount, Provider } from '@/types';
import { API_KEY_NATIVE_READY_PROVIDERS, NATIVE_RUNTIME_PROVIDERS } from './native-runtime-providers';

export interface RuntimeProviderDescriptor {
  readonly provider: Provider;
  acceptsAccount(account: ChatAccount): account is Account;
}

export class RuntimeProviderRegistry {
  private readonly descriptors = new Map<Provider, RuntimeProviderDescriptor>();

  constructor(descriptors: readonly RuntimeProviderDescriptor[] = []) {
    descriptors.forEach((descriptor) => this.register(descriptor));
  }

  register(descriptor: RuntimeProviderDescriptor): void {
    this.descriptors.set(descriptor.provider, descriptor);
  }

  resolve(provider: Provider): RuntimeProviderDescriptor | undefined {
    return this.descriptors.get(provider);
  }

  providers(): Provider[] {
    return [...this.descriptors.keys()];
  }
}

// 每个原生会话 provider 一个描述符：OAuth/宿主登录账号一律接受；API Key 账号只在
// 该 provider 的原生 CLI 能用密钥跑真会话时接受（与后端 apiKeyNativeReady 同源）。
function nativeCredentialProvider(provider: Provider): RuntimeProviderDescriptor {
  const apiKeyReady = API_KEY_NATIVE_READY_PROVIDERS.has(provider);
  return {
    provider,
    acceptsAccount: (account): account is Account => (
      account.provider === provider
      && !isGatewayAccount(account)
      && (!account.apiKeyMode || apiKeyReady)
      && Boolean(account.accountRef)
    ),
  };
}

// 名单与服务端 canonical 驱动注册同源（native-runtime-providers）：全部原生会话 provider 都走
// canonical，legacy 表面不再承接任何 provider。
export const chatRuntimeProviders = new RuntimeProviderRegistry(
  NATIVE_RUNTIME_PROVIDERS.map((provider) => nativeCredentialProvider(provider as Provider)),
);

function isGatewayAccount(account: ChatAccount): boolean {
  return Boolean((account as { readonly gateway?: boolean }).gateway);
}
