import type { Account, ChatAccount, Provider } from '@/types';

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

function nativeCredentialProvider(provider: Provider): RuntimeProviderDescriptor {
  return {
    provider,
    acceptsAccount: (account): account is Account => (
      account.provider === provider
      && !isGatewayAccount(account)
      && !account.apiKeyMode
      && Boolean(account.accountRef)
    ),
  };
}

export const chatRuntimeProviders = new RuntimeProviderRegistry([
  nativeCredentialProvider('codex'),
]);

function isGatewayAccount(account: ChatAccount): boolean {
  return Boolean((account as { readonly gateway?: boolean }).gateway);
}
