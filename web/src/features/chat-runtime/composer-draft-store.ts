import { resolveActiveServer } from '@/services/webui-auth-transport';

const STORAGE_KEY = 'aih:composer-drafts:v1';
const MAX_DRAFTS = 80;

export interface ComposerDraftIdentity {
  readonly sessionId?: string;
  readonly provider?: string;
  readonly accountRef?: string;
  readonly workspaceMode?: string;
  readonly projectPath?: string;
}

function draftKey(identity: ComposerDraftIdentity): string {
  const server = resolveActiveServer();
  return [
    server.serverId || 'local',
    server.isRemote ? 'remote' : 'same-origin',
    identity.workspaceMode || 'chat',
    identity.sessionId || 'new',
    identity.provider || '',
    identity.accountRef || '',
    identity.projectPath || '',
  ].map((part) => encodeURIComponent(String(part))).join('|');
}

function readAll(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}');
    if (!parsed || typeof parsed !== 'object') return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, value]) => typeof value === 'string'));
  } catch {
    return {};
  }
}

export function readComposerDraft(identity: ComposerDraftIdentity): string {
  return readAll()[draftKey(identity)] || '';
}

export function writeComposerDraft(identity: ComposerDraftIdentity, value: string): void {
  if (typeof window === 'undefined') return;
  try {
    const key = draftKey(identity);
    const all = readAll();
    if (value) all[key] = value;
    else delete all[key];
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(Object.entries(all).slice(-MAX_DRAFTS))));
  } catch {
    // Storage failures must never interrupt typing.
  }
}

export function clearComposerDraft(identity: ComposerDraftIdentity): void {
  writeComposerDraft(identity, '');
}

export function composerDraftKey(identity: ComposerDraftIdentity): string {
  return draftKey(identity);
}
