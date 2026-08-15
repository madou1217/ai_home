import { resolveActiveControlPlaneProfile } from '../control-plane-selection.ts';
import { listControlPlaneProfiles } from '../control-plane-profiles.ts';
import { createServerTransport } from '../server-transport/index.ts';
import {
  AccountManagementClient,
  type AccountManagementClientOptions
} from './client.ts';
import { AccountManagementError } from './errors.ts';

// createActiveAccountManagementClient 每次解析当前 Server Profile，避免切服后复用旧端点。
export async function createActiveAccountManagementClient(
  overrides: Partial<AccountManagementClientOptions> = {}
): Promise<AccountManagementClient> {
  const profiles = listControlPlaneProfiles();
  const profileId = overrides.profileId
    || resolveActiveControlPlaneProfile(profiles).profileId;
  if (!profileId) throw new AccountManagementError('active_server_profile_missing');
  const transport = overrides.transport || await createServerTransport({
    browser: {
      resolveProfile(requestedProfileId) {
        const profile = profiles.find(({ id }) => id === requestedProfileId);
        if (!profile) throw new AccountManagementError('server_profile_not_found');
        return {
          endpoint: profile.endpoint,
          managementKey: profile.managementKey
        };
      }
    }
  });
  return new AccountManagementClient({
    transport,
    profileId,
    ...(overrides.timeoutMs !== undefined ? { timeoutMs: overrides.timeoutMs } : {})
  });
}
