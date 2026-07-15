export interface NativeServerProfileSummary {
  id: string;
  name: string;
  endpoint: string;
  credentialRef: string;
  managementKeyConfigured: boolean;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface NativeServerProfileList {
  profiles: NativeServerProfileSummary[];
  activeProfileId: string;
}

export interface NativeServerProfileUpsertInput {
  id?: string;
  name: string;
  endpoint: string;
  managementKey?: string;
  metadata?: Record<string, unknown>;
}

export interface NativeManagementKeyRotateResponse {
  rotated: boolean;
  profile: NativeServerProfileSummary;
}

type TauriWindow = Window & {
  __TAURI__?: unknown;
  __TAURI_IPC__?: unknown;
};

export function isNativeDesktopRuntime() {
  if (typeof window === 'undefined') return false;
  const runtime = window as TauriWindow;
  return Boolean(runtime.__TAURI__ || runtime.__TAURI_IPC__);
}

async function invokeNative<T>(command: string, input: Record<string, unknown>): Promise<T> {
  if (!isNativeDesktopRuntime()) throw new Error('native_desktop_runtime_unavailable');
  const { invoke } = await import('@tauri-apps/api/tauri');
  try {
    return await invoke<T>(command, { input });
  } catch (error) {
    const source = error && typeof error === 'object'
      ? error as { code?: unknown; message?: unknown; status?: unknown }
      : {};
    const code = String(source.code || 'native_profile_command_failed');
    const message = String(source.message || code);
    const safeMessage = /bearer|authorization|management.?key\s*[:=]|https?:\/\//i.test(message)
      ? code
      : message.slice(0, 512);
    const wrapped = new Error(safeMessage) as Error & { code?: string; status?: number };
    wrapped.code = code;
    const status = Number(source.status);
    if (Number.isInteger(status)) wrapped.status = status;
    throw wrapped;
  }
}

export function listNativeServerProfiles(): Promise<NativeServerProfileList> {
  return invokeNative('desktop_profile_list', {});
}

export async function upsertNativeServerProfile(
  input: NativeServerProfileUpsertInput
): Promise<NativeServerProfileSummary> {
  const result = await invokeNative<{ profile: NativeServerProfileSummary }>(
    'desktop_profile_upsert',
    input as unknown as Record<string, unknown>
  );
  return result.profile;
}

export function rotateNativeServerManagementKey(
  profileId: string,
  managementKey: string
): Promise<NativeManagementKeyRotateResponse> {
  return invokeNative<NativeManagementKeyRotateResponse>(
    'desktop_management_key_rotate',
    { profileId, managementKey }
  );
}

export async function removeNativeServerProfile(profileId: string) {
  return invokeNative<{ removed: boolean; activeProfileId: string }>(
    'desktop_profile_remove',
    { profileId }
  );
}

export async function setActiveNativeServerProfile(profileId: string) {
  return invokeNative<{
    activeProfileId: string;
    profile: NativeServerProfileSummary | null;
  }>('desktop_profile_set_active', { profileId });
}

export async function getActiveNativeServerProfile() {
  return invokeNative<{ profile: NativeServerProfileSummary | null }>(
    'desktop_profile_get_active',
    {}
  );
}
