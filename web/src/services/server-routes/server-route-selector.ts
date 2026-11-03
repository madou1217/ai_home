import type { ServerRoute, ServerRouteHealth } from '@/types';
import { mergeServerRoutes, normalizeServerRoute } from './server-route-normalizer';

const DEFAULT_STICKY_MS = 30_000;
const DEFAULT_HYSTERESIS_SCORE = 8;
const DEFAULT_DEBOUNCE_MS = 1_500;

export type ServerRouteOperation = 'read' | 'write' | 'stream';

export interface ServerRouteSelectionState {
  selectedRouteId: string;
  selectedAt: number;
  challengerRouteId: string;
  challengerSince: number;
}

export interface ServerRouteSelectionOptions {
  operation: ServerRouteOperation;
  idempotencyKey?: string;
  sessionResumeId?: string;
  now?: number;
  previous?: ServerRouteSelectionState | null;
  stickyMs?: number;
  hysteresisScore?: number;
  debounceMs?: number;
}

export interface ServerRouteSelection {
  route: ServerRoute | null;
  state: ServerRouteSelectionState;
  switched: boolean;
  retryAllowed: boolean;
  reason: 'selected' | 'sticky' | 'session-sticky' | 'hysteresis' | 'debouncing'
    | 'failover' | 'unsafe-failover' | 'no-route';
}

export function scoreServerRoute(value: unknown): number {
  const route = normalizeServerRoute(value);
  if (!route || route.health === 'offline') return Number.NEGATIVE_INFINITY;
  const healthBase: Record<ServerRouteHealth, number> = {
    healthy: 100,
    unknown: 65,
    degraded: 40,
    offline: Number.NEGATIVE_INFINITY
  };
  const latencyPenalty = route.rttMs > 0 ? Math.min(35, route.rttMs / 8) : 8;
  const failurePenalty = route.failureRate * 60;
  const consecutiveFailurePenalty = Math.min(40, route.consecutiveFailures * 8);
  return healthBase[route.health] - latencyPenalty - failurePenalty - consecutiveFailurePenalty;
}

function hasValue(value: unknown) {
  return Boolean(String(value ?? '').trim());
}

function canFailover(options: ServerRouteSelectionOptions) {
  if (options.operation === 'read') return true;
  if (options.operation === 'write') return hasValue(options.idempotencyKey);
  return hasValue(options.sessionResumeId);
}

function selectionState(
  selectedRouteId: string,
  selectedAt: number,
  challengerRouteId = '',
  challengerSince = 0
): ServerRouteSelectionState {
  return { selectedRouteId, selectedAt, challengerRouteId, challengerSince };
}

export function selectServerRoute(
  values: unknown[],
  options: ServerRouteSelectionOptions
): ServerRouteSelection {
  const now = Math.max(0, Number(options.now ?? Date.now()) || 0);
  const routes = mergeServerRoutes(values);
  const candidates = routes
    .map((route) => ({ route, score: scoreServerRoute(route) }))
    .filter((candidate) => Number.isFinite(candidate.score))
    .sort((left, right) => right.score - left.score || left.route.id.localeCompare(right.route.id));
  const best = candidates[0] || null;
  const previous = options.previous || selectionState('', 0);
  const current = routes.find((route) => route.id === previous.selectedRouteId) || null;
  const currentScore = current ? scoreServerRoute(current) : Number.NEGATIVE_INFINITY;

  if (!best) {
    return {
      route: null,
      state: previous,
      switched: false,
      retryAllowed: false,
      reason: 'no-route'
    };
  }
  if (!previous.selectedRouteId) {
    return {
      route: best.route,
      state: selectionState(best.route.id, now),
      switched: false,
      retryAllowed: false,
      reason: 'selected'
    };
  }
  if (!current || !Number.isFinite(currentScore)) {
    if (!canFailover(options)) {
      return {
        route: null,
        state: previous,
        switched: false,
        retryAllowed: false,
        reason: 'unsafe-failover'
      };
    }
    return {
      route: best.route,
      state: selectionState(best.route.id, now),
      switched: best.route.id !== previous.selectedRouteId,
      retryAllowed: true,
      reason: 'failover'
    };
  }
  if (best.route.id === current.id) {
    return {
      route: current,
      state: selectionState(current.id, previous.selectedAt),
      switched: false,
      retryAllowed: false,
      reason: 'selected'
    };
  }
  if (options.operation === 'stream') {
    return {
      route: current,
      state: selectionState(current.id, previous.selectedAt),
      switched: false,
      retryAllowed: false,
      reason: 'session-sticky'
    };
  }
  if (options.operation === 'write' && !canFailover(options)) {
    return {
      route: current,
      state: selectionState(current.id, previous.selectedAt),
      switched: false,
      retryAllowed: false,
      reason: 'sticky'
    };
  }

  const stickyMs = Math.max(0, Number(options.stickyMs ?? DEFAULT_STICKY_MS) || 0);
  if (now - previous.selectedAt < stickyMs) {
    return {
      route: current,
      state: selectionState(current.id, previous.selectedAt),
      switched: false,
      retryAllowed: false,
      reason: 'sticky'
    };
  }
  const hysteresisScore = Math.max(0, Number(
    options.hysteresisScore ?? DEFAULT_HYSTERESIS_SCORE
  ) || 0);
  if (best.score - currentScore < hysteresisScore) {
    return {
      route: current,
      state: selectionState(current.id, previous.selectedAt),
      switched: false,
      retryAllowed: false,
      reason: 'hysteresis'
    };
  }
  const debounceMs = Math.max(0, Number(options.debounceMs ?? DEFAULT_DEBOUNCE_MS) || 0);
  if (debounceMs > 0) {
    if (previous.challengerRouteId !== best.route.id) {
      return {
        route: current,
        state: selectionState(current.id, previous.selectedAt, best.route.id, now),
        switched: false,
        retryAllowed: false,
        reason: 'debouncing'
      };
    }
    if (now - previous.challengerSince < debounceMs) {
      return {
        route: current,
        state: previous,
        switched: false,
        retryAllowed: false,
        reason: 'debouncing'
      };
    }
  }
  return {
    route: best.route,
    state: selectionState(best.route.id, now),
    switched: true,
    retryAllowed: canFailover(options),
    reason: 'selected'
  };
}
