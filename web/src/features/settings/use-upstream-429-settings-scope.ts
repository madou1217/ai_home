import { useCallback, useEffect, useRef, useState } from 'react';
import {
  isTransportTargetStillValid,
  resolveActiveTransportTarget,
  resolveWebUiManagementKey,
  subscribeTransportTargetChange,
  type WebUiTransportTarget
} from '@/services/webui-auth-transport';
import type {
  AccountUpstream429RetryMode,
  Upstream429RetryGlobalConfig
} from '@/types';

const SERVER_PROFILE_STORAGE_KEY = 'aih:control-plane-profiles:v1';

let monotonicScopeGeneration = 0;

function nextScopeGeneration(): number {
  monotonicScopeGeneration += 1;
  return monotonicScopeGeneration;
}

/** Non-cryptographic FNV-1a 32-bit digest so raw management keys never enter React state or logs. */
function digestNonSecret(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function readStoredActiveProfileRevision(serverId: string): string {
  if (typeof window === 'undefined' || !serverId) return 'none';
  try {
    const raw = window.localStorage.getItem(SERVER_PROFILE_STORAGE_KEY);
    const profiles = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(profiles)) return 'none';
    const profile = profiles.find((item) => item && item.id === serverId);
    if (!profile || typeof profile !== 'object') return 'missing';
    const endpoint = String((profile as { endpoint?: unknown }).endpoint || '').trim();
    const keyHash = digestNonSecret(String((profile as { managementKey?: unknown }).managementKey || '').trim());
    return `${endpoint}|k:${keyHash}`;
  } catch {
    return 'unreadable';
  }
}

export interface Upstream429TargetSnapshot {
  readonly target: WebUiTransportTarget;
  /** Non-secret scope fingerprint incorporating target routing + local/profile credential revisions. */
  readonly fingerprint: string;
}

export interface Upstream429TransportScope extends Upstream429TargetSnapshot {
  /** Strictly monotonic generation; A -> B -> A always produces distinct generations. */
  readonly generation: number;
}

export function readUpstream429TargetSnapshot(): Upstream429TargetSnapshot {
  const target = resolveActiveTransportTarget();
  const localKeyHash = digestNonSecret(resolveWebUiManagementKey());
  const profileRevision = readStoredActiveProfileRevision(target.serverId);
  const fingerprint = `${target.scopeKey}|lk:${localKeyHash}|pr:${profileRevision}`;
  return { target, fingerprint };
}

/**
 * Tracks the active WebUI transport target (including endpoint & credential revisions)
 * with a strictly monotonic generation across same-tab profile edits and cross-tab storage updates.
 */
export function useUpstream429TransportScope() {
  const [scope, setScope] = useState<Upstream429TransportScope>(() => {
    const snapshot = readUpstream429TargetSnapshot();
    return { ...snapshot, generation: nextScopeGeneration() };
  });
  const scopeRef = useRef<Upstream429TransportScope>(scope);
  scopeRef.current = scope;

  useEffect(() => {
    const syncScope = () => {
      const next = readUpstream429TargetSnapshot();
      const prev = scopeRef.current;
      if (next.fingerprint === prev.fingerprint && next.target.scopeKey === prev.target.scopeKey) {
        return;
      }
      const updated: Upstream429TransportScope = {
        ...next,
        generation: nextScopeGeneration()
      };
      scopeRef.current = updated;
      setScope(updated);
    };

    syncScope();
    return subscribeTransportTargetChange(syncScope);
  }, []);

  const isScopeCurrent = useCallback((captured: Upstream429TransportScope): boolean => {
    const current = scopeRef.current;
    if (current.generation !== captured.generation || current.fingerprint !== captured.fingerprint) {
      return false;
    }
    if (!isTransportTargetStillValid(captured.target)) {
      return false;
    }
    const live = readUpstream429TargetSnapshot();
    return live.fingerprint === captured.fingerprint && live.target.scopeKey === captured.target.scopeKey;
  }, []);

  return { scope, isScopeCurrent };
}

export function isValidBackoffSecondsArray(value: unknown): value is number[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10) {
    return false;
  }
  let sum = 0;
  for (const item of value) {
    if (typeof item !== 'number' || !Number.isFinite(item) || !Number.isInteger(item)) {
      return false;
    }
    if (item < 1 || item > 300) {
      return false;
    }
    sum += item;
    if (sum > 1800) {
      return false;
    }
  }
  return true;
}

/**
 * Strictly parses upstream429Retry from a ServerConfig response.
 * Returns null if the response payload is malformed so the UI stays in error state instead
 * of masking corrupt data as default config. Legacy backends omitting upstream429Retry on a
 * valid ServerConfig object (with host/port) still resolve to canonical defaults [30].
 */
export function parseGlobalUpstream429RetryConfig(
  server: unknown
): Upstream429RetryGlobalConfig | null {
  if (!server || typeof server !== 'object' || Array.isArray(server)) {
    return null;
  }
  const record = server as Record<string, unknown>;
  const hasServerShape = typeof record.host === 'string' || typeof record.port === 'number';
  if (!Object.prototype.hasOwnProperty.call(record, 'upstream429Retry') || record.upstream429Retry === undefined) {
    if (!hasServerShape) return null;
    return { enabled: true, backoffSeconds: [30] };
  }
  const retry = record.upstream429Retry;
  if (!retry || typeof retry !== 'object' || Array.isArray(retry)) {
    return null;
  }
  const retryRecord = retry as Record<string, unknown>;
  if (typeof retryRecord.enabled !== 'boolean') {
    return null;
  }
  if (!isValidBackoffSecondsArray(retryRecord.backoffSeconds)) {
    return null;
  }
  return {
    enabled: retryRecord.enabled,
    backoffSeconds: [...retryRecord.backoffSeconds]
  };
}

export interface ParsedAccountUpstream429Retry {
  readonly global: Upstream429RetryGlobalConfig;
  readonly mode: AccountUpstream429RetryMode;
  readonly backoffSeconds: number[];
}

/**
 * Strictly validates GET/POST account upstream-429-retry responses (ok flag, target accountRef,
 * valid global config, and strict 3-mode override schema where enabled requires non-empty schedule).
 */
export function parseAccountUpstream429RetryResponse(
  response: unknown,
  expectedAccountRef: string
): ParsedAccountUpstream429Retry | null {
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    return null;
  }
  const record = response as Record<string, unknown>;
  if (record.ok !== true) {
    return null;
  }
  if (typeof record.accountRef !== 'string' || record.accountRef.trim() !== expectedAccountRef.trim()) {
    return null;
  }
  const globalRaw = record.global;
  if (!globalRaw || typeof globalRaw !== 'object' || Array.isArray(globalRaw)) {
    return null;
  }
  const globalObj = globalRaw as Record<string, unknown>;
  if (typeof globalObj.enabled !== 'boolean' || !isValidBackoffSecondsArray(globalObj.backoffSeconds)) {
    return null;
  }
  const overrideRaw = record.override;
  if (!overrideRaw || typeof overrideRaw !== 'object' || Array.isArray(overrideRaw)) {
    return null;
  }
  const overrideObj = overrideRaw as Record<string, unknown>;
  const mode = overrideObj.mode;
  if (mode !== 'inherit' && mode !== 'enabled' && mode !== 'disabled') {
    return null;
  }
  let backoffSeconds: number[] = [];
  if (mode === 'enabled') {
    if (!isValidBackoffSecondsArray(overrideObj.backoffSeconds)) {
      return null;
    }
    backoffSeconds = [...overrideObj.backoffSeconds];
  }
  return {
    global: {
      enabled: globalObj.enabled,
      backoffSeconds: [...globalObj.backoffSeconds]
    },
    mode,
    backoffSeconds
  };
}
