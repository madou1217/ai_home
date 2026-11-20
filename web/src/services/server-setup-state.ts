import type { ControlPlaneProfile } from '@/types';
import {
  isAutoCurrentControlPlaneProfile,
  isControlPlaneManagementKeyConfigured,
  normalizeControlPlaneEndpoint
} from './control-plane-profiles';
import { resolveStoredActiveControlPlaneProfile } from './control-plane-selection';

export type ServerSetupDialogMode = 'closed' | 'initial' | 'add' | 'authorize';

export interface ServerSetupDialogState {
  mode: ServerSetupDialogMode;
  profileId: string;
}

export const CLOSED_SERVER_SETUP_DIALOG: ServerSetupDialogState = {
  mode: 'closed',
  profileId: ''
};

export function resolveRequiredServerSetupDialog(
  profiles: ControlPlaneProfile[],
  activeProfileId = ''
): ServerSetupDialogState | null {
  const items = Array.isArray(profiles) ? profiles : [];
  if (items.length === 0) {
    return { mode: 'initial', profileId: '' };
  }
  if (!items.every(isAutoCurrentControlPlaneProfile)) return null;
  const active = resolveStoredActiveControlPlaneProfile(items, activeProfileId);
  return {
    mode: 'initial',
    profileId: active.profileId || items[0].id
  };
}

export function resolveServerSetupFormDefaults(input: {
  dialog: ServerSetupDialogState;
  profiles: ControlPlaneProfile[];
  browserEndpoint?: string;
}) {
  const profile = input.profiles.find((item) => item.id === input.dialog.profileId) || null;
  if (profile) {
    return {
      endpoint: profile.endpoint,
      name: input.dialog.mode === 'initial'
        ? 'AIH Server'
        : profile.name || profile.endpoint
    };
  }
  if (input.dialog.mode === 'initial') {
    return {
      endpoint: normalizeControlPlaneEndpoint(String(input.browserEndpoint || '')),
      name: 'AIH Server'
    };
  }
  return {
    endpoint: '',
    name: 'AIH Server'
  };
}

/** 401 清空旧 Key 后，若带 gate=1 或引导明确报 unauthorized，自动打开当前 profile 的授权弹窗。 */
export function resolveAutoAuthorizeDialog(input: {
  activeProfile: ControlPlaneProfile | null;
  gateRequested: boolean;
  bootstrapIssue: 'unauthorized' | null;
}): ServerSetupDialogState | null {
  if (!input.activeProfile) return null;
  if (!input.gateRequested && input.bootstrapIssue !== 'unauthorized') return null;
  if (input.bootstrapIssue !== 'unauthorized' && isControlPlaneManagementKeyConfigured(input.activeProfile)) return null;
  return { mode: 'authorize', profileId: input.activeProfile.id };
}
