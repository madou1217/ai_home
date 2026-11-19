/**
 * Per-scope local WebSocket multiplexer for allowlisted WebUI watch streams.
 *
 * Keeps at most one lazy WebSocket per captured local transport scope, sends
 * Bearer credentials exclusively in the first JSON text frame, enforces a 45s
 * silence watchdog + 10s stable backoff reset + pagehide/bfcache cleanup, and
 * falls back to captured-target AuthorizedWebUiEventSource SSE ONLY after a
 * definitive authenticated GET capability probe confirms the backend lacks
 * /v0/webui/watch/ws (404/501); unknown/network/policy errors stay on bounded
 * WebSocket backoff.
 *
 * Imports nothing from webui-auth-transport to guarantee an acyclic graph.
 */
import {
  computeWatchBackoffMs,
  readMultiplexedWatchPath,
  WATCH_MULTIPLEX_WEBSOCKET_PATH,
  WATCH_STABLE_RESET_MS,
  WatchMultiplexEventSource,
  type WatchMultiplexClientBridge,
  type WatchMultiplexOpenOptions,
  type WatchMultiplexTargetScope,
  type WatchWebSocketSupportProbeResult,
} from './watch-multiplex-source';

export {
  readMultiplexedWatchPath,
  WATCH_MULTIPLEX_WEBSOCKET_PATH,
  type WatchMultiplexOpenOptions,
  type WatchMultiplexTargetScope,
  type WatchWebSocketSupportProbeResult,
};

const MAX_UNOPENED_WS_PROBES = 2;
const CAPABILITY_PROBE_TIMEOUT_MS = 5_000;
const CAPABILITY_PROBE_COOLDOWN_MS = 30_000;
const SILENCE_TIMEOUT_MS = 45_000;
const WATCHDOG_POLL_MS = 5_000;
const WS_AUTH_OR_POLICY_CLOSE_CODES = new Set([1008, 4400, 4401, 4403]);

interface WatchServerFrame {
  type?: unknown;
  id?: unknown;
  data?: unknown;
  code?: unknown;
}

function buildSameOriginWatchWebSocketUrl(origin: string): string {
  const url = new URL(WATCH_MULTIPLEX_WEBSOCKET_PATH, origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.search = '';
  url.hash = '';
  return url.toString();
}

let nextSourceSeq = 0;
let nextWireSubscriptionSeq = 0;

function allocateSourceId(): string {
  nextSourceSeq += 1;
  return `wsrc-${nextSourceSeq}`;
}

function allocateWireSubscriptionId(): string {
  nextWireSubscriptionSeq += 1;
  return `wsub-${nextWireSubscriptionSeq}`;
}

class WatchMultiplexClient implements WatchMultiplexClientBridge {
  private readonly registryKey: string;
  private readonly wsUrl: string;
  private readonly readManagementKey: () => string;
  private readonly isTargetStillValid: () => boolean;
  private readonly probeWebSocketSupport?: (signal: AbortSignal) => Promise<WatchWebSocketSupportProbeResult>;
  private readonly unsubscribeTargetChange: () => void;
  private readonly onDisposed: (key: string, client: WatchMultiplexClient) => void;

  // Local sources keep a stable id (`wsrc-*`), while every subscribe, retry,
  // and reconnect rotates a fresh wire ID (`wsub-*`) so already-dequeued TCP
  // frames from an older server generation can never match a newer generation.
  private readonly subscriptions = new Map<string, WatchMultiplexEventSource>();
  private readonly sourceToWireId = new Map<string, string>();
  private readonly wireIdToSource = new Map<string, WatchMultiplexEventSource>();
  private socket: WebSocket | null = null;
  private socketGen = 0;
  private authenticated = false;
  private authenticatedAt = 0;
  private wsSupportedConfirmed = false;
  private unopenedFailures = 0;
  private reconnectAttempt = 0;
  private lastActivityAt = Date.now();
  private fallbackMode = false;
  private suspended = false;
  private disposed = false;

  private probeController: AbortController | null = null;
  private probeTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private probeGen = 0;
  private lastProbeAt = 0;

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;

  private handleOnline = () => {
    if (this.disposed || this.suspended || this.fallbackMode) return;
    this.reconnectAttempt = 0;
    this.lastProbeAt = 0;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      this.connect();
      return;
    }
    if (this.socket && Date.now() - this.lastActivityAt >= SILENCE_TIMEOUT_MS) {
      this.failCurrentSocket(this.socket, this.socketGen, true);
    }
  };

  private handleCheckConnection = () => {
    if (this.disposed || this.suspended || this.fallbackMode || !this.socket) return;
    if (Date.now() - this.lastActivityAt >= SILENCE_TIMEOUT_MS) {
      this.failCurrentSocket(this.socket, this.socketGen, true);
    }
  };

  private handlePageHide = (event: PageTransitionEvent) => {
    if (this.disposed) return;
    if (!event.persisted) {
      this.dispose(true);
      return;
    }
    // Entering bfcache: close active socket and stop timers/probes without
    // permanently closing subscriptions so pageshow can resume cleanly.
    this.suspended = true;
    this.abortCapabilityProbe();
    this.clearReconnectTimer();
    this.clearStableTimer();
    this.clearWatchdogTimer();
    if (this.socket) {
      this.socketGen += 1;
      const active = this.socket;
      this.socket = null;
      this.authenticated = false;
      this.authenticatedAt = 0;
      this.clearAllWireMappings();
      this.detachSocket(active);
    }
    this.notifySubscriptionsDisconnect(false);
  };

  private handlePageShow = (event: PageTransitionEvent) => {
    if (this.disposed || !event.persisted || !this.suspended) return;
    this.suspended = false;
    if (this.fallbackMode || this.subscriptions.size === 0) return;
    if (!this.isTargetStillValid()) {
      this.dispose(true);
      return;
    }
    this.reconnectAttempt = 0;
    this.ensureWatchdog();
    this.connect();
  };

  private handleTargetChange = () => {
    if (this.disposed) return;
    if (!this.isTargetStillValid()) {
      this.dispose(true);
    }
  };

  constructor(
    registryKey: string,
    wsUrl: string,
    options: WatchMultiplexOpenOptions,
    onDisposed: (key: string, client: WatchMultiplexClient) => void,
  ) {
    this.registryKey = registryKey;
    this.wsUrl = wsUrl;
    this.readManagementKey = options.readManagementKey;
    this.isTargetStillValid = options.isTargetStillValid;
    this.probeWebSocketSupport = options.probeWebSocketSupport;
    this.onDisposed = onDisposed;
    this.unsubscribeTargetChange = options.subscribeTargetChange(this.handleTargetChange);

    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.handleOnline);
      window.addEventListener('pagehide', this.handlePageHide);
      window.addEventListener('pageshow', this.handlePageShow);
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.handleCheckConnection);
    }
    this.ensureWatchdog();
  }

  attach(source: WatchMultiplexEventSource): void {
    if (source.isClosed) return;
    if (this.disposed) {
      source.forceCloseFromClient();
      return;
    }
    if (!this.isTargetStillValid()) {
      this.dispose(true);
      source.forceCloseFromClient();
      return;
    }
    this.subscriptions.set(source.id, source);
    if (this.fallbackMode) {
      source.activateFallback();
      return;
    }
    if (this.suspended) return;
    if (this.authenticated && this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.sendSubscribe(source);
      return;
    }
    if (!this.socket && this.reconnectTimer === null) {
      this.connect();
    }
  }

  detach(source: WatchMultiplexEventSource): void {
    const existing = this.subscriptions.get(source.id);
    if (existing !== source) return;
    this.subscriptions.delete(source.id);
    this.retireWireSubscription(source, true);
    if (this.subscriptions.size === 0) {
      this.dispose(false);
    }
  }

  requestResubscribe(source: WatchMultiplexEventSource): void {
    if (this.disposed || this.suspended || this.fallbackMode || source.isClosed) return;
    if (this.subscriptions.get(source.id) !== source) return;
    if (this.authenticated && this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.sendSubscribe(source);
    }
  }

  private retireWireSubscription(source: WatchMultiplexEventSource, sendUnsubscribe: boolean): void {
    const oldWireId = this.sourceToWireId.get(source.id);
    if (!oldWireId) return;
    this.sourceToWireId.delete(source.id);
    if (this.wireIdToSource.get(oldWireId) === source) {
      this.wireIdToSource.delete(oldWireId);
    }
    if (sendUnsubscribe && this.authenticated && this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.sendJSON({ type: 'unsubscribe', id: oldWireId });
    }
  }

  private clearAllWireMappings(): void {
    this.sourceToWireId.clear();
    this.wireIdToSource.clear();
  }

  private sendSubscribe(source: WatchMultiplexEventSource): boolean {
    if (source.isClosed || source.isFallbackActive) return true;
    this.retireWireSubscription(source, true);
    const wireId = allocateWireSubscriptionId();
    this.sourceToWireId.set(source.id, wireId);
    this.wireIdToSource.set(wireId, source);
    const active = this.socket;
    const gen = this.socketGen;
    const sent = this.sendJSON({
      type: 'subscribe',
      id: wireId,
      path: source.path,
    });
    if (!sent && active && this.socket === active && this.socketGen === gen) {
      this.failCurrentSocket(active, gen, true);
    }
    return sent;
  }

  private sendJSON(payload: Record<string, string>): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    try {
      this.socket.send(JSON.stringify(payload));
      return true;
    } catch (_error) {
      return false;
    }
  }

  private connect(): void {
    if (this.disposed || this.suspended || this.fallbackMode || this.subscriptions.size === 0) return;
    if (!this.isTargetStillValid()) {
      this.dispose(true);
      return;
    }
    const gen = ++this.socketGen;
    this.authenticated = false;
    this.authenticatedAt = 0;
    this.lastActivityAt = Date.now();

    let socket: WebSocket;
    try {
      socket = new WebSocket(this.wsUrl);
    } catch (_error) {
      this.handlePreOpenFailure();
      return;
    }

    this.socket = socket;
    let opened = false;

    socket.onopen = () => {
      if (this.disposed || this.socket !== socket || this.socketGen !== gen) return;
      opened = true;
      this.lastActivityAt = Date.now();
      const key = String(this.readManagementKey() || '').trim();
      const sent = this.sendJSON({
        type: 'auth',
        authorization: key ? `Bearer ${key}` : '',
      });
      if (!sent) {
        this.failCurrentSocket(socket, gen, true);
      }
    };

    socket.onmessage = (event) => {
      if (this.disposed || this.socket !== socket || this.socketGen !== gen) return;
      if (typeof event.data !== 'string') {
        this.failCurrentSocket(socket, gen, true);
        return;
      }
      let frame: WatchServerFrame | null = null;
      try {
        frame = JSON.parse(event.data) as WatchServerFrame;
      } catch (_error) {
        this.failCurrentSocket(socket, gen, true);
        return;
      }
      if (!frame || typeof frame !== 'object') {
        this.failCurrentSocket(socket, gen, true);
        return;
      }
      this.lastActivityAt = Date.now();
      this.handleServerFrame(socket, gen, frame);
    };

    // Browser network errors are followed by onclose; centralize retry/fallback
    // transitions in onclose to avoid duplicate reconnect timers.
    socket.onerror = () => {
      // Handled by onclose.
    };

    socket.onclose = (event) => {
      if (this.disposed || this.socket !== socket || this.socketGen !== gen) return;
      this.socket = null;
      this.settleStableWindow();
      this.authenticated = false;
      this.clearAllWireMappings();

      const closeCode = typeof event?.code === 'number' ? event.code : 1006;
      const authOrPolicyFailure = WS_AUTH_OR_POLICY_CLOSE_CODES.has(closeCode);
      if (!opened && !authOrPolicyFailure && !this.wsSupportedConfirmed) {
        this.handlePreOpenFailure();
        return;
      }
      if (opened) {
        this.unopenedFailures = 0;
      }
      try {
        this.notifySubscriptionsDisconnect(true);
      } finally {
        this.scheduleReconnect();
      }
    };
  }

  private handleServerFrame(socket: WebSocket, gen: number, frame: WatchServerFrame): void {
    if (frame.type === 'heartbeat') {
      return;
    }
    if (frame.type === 'authenticated') {
      if (this.authenticated) return;
      this.authenticated = true;
      this.authenticatedAt = Date.now();
      this.wsSupportedConfirmed = true;
      this.unopenedFailures = 0;
      this.abortCapabilityProbe();
      this.armStableResetTimer(socket, gen);
      for (const sub of [...this.subscriptions.values()]) {
        if (!sub.isClosed && !sub.isFallbackActive && !sub.isRetryPending) {
          if (!this.sendSubscribe(sub)) break;
        }
      }
      return;
    }
    if (!this.authenticated) {
      this.failCurrentSocket(socket, gen, true);
      return;
    }
    if (typeof frame.id !== 'string' || !frame.id) {
      return;
    }
    // Look up strictly by active wire ID; messages carrying retired/unknown
    // old wire IDs (e.g. already popped onto TCP before unsubscribe) are ignored.
    const sub = this.wireIdToSource.get(frame.id);
    if (!sub || sub.isClosed) {
      return;
    }
    if (frame.type === 'open') {
      sub.handleOpen();
      return;
    }
    if (frame.type === 'event' && typeof frame.data === 'string') {
      sub.handleMessage(frame.data);
      return;
    }
    if (frame.type === 'error') {
      // Retire and explicitly unsubscribe this failed wire ID immediately so
      // any subsequent retry allocates a fresh wire ID and ignores stale frames.
      this.retireWireSubscription(sub, true);
      sub.handleSubError(typeof frame.code === 'string' ? frame.code : 'watch_error');
    }
  }

  private handlePreOpenFailure(): void {
    this.unopenedFailures += 1;
    try {
      this.notifySubscriptionsDisconnect(true);
    } finally {
      this.scheduleReconnect();
    }
    if (
      !this.wsSupportedConfirmed
      && this.unopenedFailures >= MAX_UNOPENED_WS_PROBES
    ) {
      this.maybeStartCapabilityProbe();
    }
  }

  private maybeStartCapabilityProbe(): void {
    if (
      this.disposed
      || this.suspended
      || this.fallbackMode
      || this.wsSupportedConfirmed
      || this.subscriptions.size === 0
      || !this.probeWebSocketSupport
      || this.probeController !== null
    ) {
      return;
    }
    const now = Date.now();
    if (this.lastProbeAt > 0 && now - this.lastProbeAt < CAPABILITY_PROBE_COOLDOWN_MS) {
      return;
    }
    if (!this.isTargetStillValid()) {
      this.dispose(true);
      return;
    }
    if (typeof AbortController === 'undefined') {
      return;
    }

    this.lastProbeAt = now;
    const expectedProbeGen = ++this.probeGen;
    const controller = new AbortController();
    this.probeController = controller;
    this.probeTimeoutTimer = setTimeout(() => {
      if (this.probeController === controller) {
        controller.abort();
      }
    }, CAPABILITY_PROBE_TIMEOUT_MS);

    void this.probeWebSocketSupport(controller.signal)
      .then((result) => {
        if (this.probeController === controller) {
          this.probeController = null;
          this.clearProbeTimeoutTimer();
        }
        if (
          this.disposed
          || this.suspended
          || this.fallbackMode
          || this.wsSupportedConfirmed
          || this.probeGen !== expectedProbeGen
        ) {
          return;
        }
        if (!this.isTargetStillValid()) {
          this.dispose(true);
          return;
        }
        if (result === 'supported') {
          this.wsSupportedConfirmed = true;
          this.unopenedFailures = 0;
          return;
        }
        if (result === 'unsupported') {
          this.activateFallbackMode();
        }
        // 'policy' (401/403) and 'unknown' (network/5xx/timeout) MUST NOT fall
        // back to SSE; bounded WebSocket reconnect backoff continues.
      })
      .catch(() => {
        if (this.probeController === controller) {
          this.probeController = null;
          this.clearProbeTimeoutTimer();
        }
      });
  }

  private abortCapabilityProbe(): void {
    this.probeGen += 1;
    this.clearProbeTimeoutTimer();
    const controller = this.probeController;
    this.probeController = null;
    if (controller) {
      try { controller.abort(); } catch (_error) { /* ignore */ }
    }
  }

  private clearProbeTimeoutTimer(): void {
    if (this.probeTimeoutTimer !== null) {
      clearTimeout(this.probeTimeoutTimer);
      this.probeTimeoutTimer = null;
    }
  }

  private notifySubscriptionsDisconnect(emitError: boolean): void {
    for (const sub of [...this.subscriptions.values()]) {
      try {
        sub.handleTransportDisconnect(emitError);
      } catch (_error) {
        // Per-source isolation: one failing callback never blocks siblings or reconnect.
      }
    }
  }

  private activateFallbackMode(): void {
    if (this.disposed || this.fallbackMode) return;
    this.fallbackMode = true;
    this.socketGen += 1;
    this.authenticated = false;
    this.authenticatedAt = 0;
    this.clearAllWireMappings();
    this.abortCapabilityProbe();
    this.clearReconnectTimer();
    this.clearStableTimer();
    this.clearWatchdogTimer();
    if (this.socket) {
      const active = this.socket;
      this.socket = null;
      this.detachSocket(active);
    }
    for (const sub of [...this.subscriptions.values()]) {
      try {
        sub.activateFallback();
      } catch (_error) {
        // Isolate per-source fallback activation failures.
      }
    }
  }

  private failCurrentSocket(socket: WebSocket, gen: number, emitError: boolean): void {
    if (this.disposed || this.socket !== socket || this.socketGen !== gen) return;
    this.socketGen += 1;
    this.socket = null;
    this.settleStableWindow();
    this.authenticated = false;
    this.clearAllWireMappings();
    this.detachSocket(socket);
    try {
      this.notifySubscriptionsDisconnect(emitError);
    } finally {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (
      this.disposed
      || this.suspended
      || this.fallbackMode
      || this.subscriptions.size === 0
      || this.reconnectTimer !== null
    ) {
      return;
    }
    const delayMs = computeWatchBackoffMs(this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delayMs);
  }

  private armStableResetTimer(socket: WebSocket, gen: number): void {
    this.clearStableTimer();
    this.stableTimer = setTimeout(() => {
      this.stableTimer = null;
      if (!this.disposed && this.socket === socket && this.socketGen === gen && this.authenticated) {
        this.reconnectAttempt = 0;
      }
    }, WATCH_STABLE_RESET_MS);
  }

  private settleStableWindow(): void {
    this.clearStableTimer();
    if (this.authenticatedAt > 0 && Date.now() - this.authenticatedAt >= WATCH_STABLE_RESET_MS) {
      this.reconnectAttempt = 0;
    }
    this.authenticatedAt = 0;
  }

  private ensureWatchdog(): void {
    if (this.watchdogTimer !== null || typeof window === 'undefined') return;
    this.watchdogTimer = setInterval(this.handleCheckConnection, WATCHDOG_POLL_MS);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearStableTimer(): void {
    if (this.stableTimer !== null) {
      clearTimeout(this.stableTimer);
      this.stableTimer = null;
    }
  }

  private clearWatchdogTimer(): void {
    if (this.watchdogTimer !== null) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  private detachSocket(socket: WebSocket): void {
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    try { socket.close(); } catch (_error) { /* ignore */ }
  }

  private dispose(forceCloseSubs: boolean): void {
    if (this.disposed) return;
    this.disposed = true;
    this.socketGen += 1;
    this.authenticated = false;
    this.authenticatedAt = 0;
    this.abortCapabilityProbe();
    this.clearReconnectTimer();
    this.clearStableTimer();
    this.clearWatchdogTimer();
    this.unsubscribeTargetChange();
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.handleCheckConnection);
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.handleOnline);
      window.removeEventListener('pagehide', this.handlePageHide);
      window.removeEventListener('pageshow', this.handlePageShow);
    }
    if (this.socket) {
      const active = this.socket;
      this.socket = null;
      this.detachSocket(active);
    }
    const pendingSubs = [...this.subscriptions.values()];
    this.subscriptions.clear();
    this.clearAllWireMappings();
    if (forceCloseSubs) {
      for (const sub of pendingSubs) {
        try {
          sub.forceCloseFromClient();
        } catch (_error) {
          // Ensure all subscriptions and registry cleanup complete.
        }
      }
    }
    this.onDisposed(this.registryKey, this);
  }
}

const clientsByScope = new Map<string, WatchMultiplexClient>();

function removeClientFromRegistry(key: string, client: WatchMultiplexClient): void {
  if (clientsByScope.get(key) === client) {
    clientsByScope.delete(key);
  }
}

/**
 * Opens an EventSource-compatible stream for an allowlisted local watch path
 * backed by a single per-scope multiplexed WebSocket.
 *
 * Remote targets, non-allowlisted paths, invalid targets, or non-WebSocket
 * environments immediately receive the captured SSE fallback without creating
 * a WebSocket client entry.
 */
export function openWatchMultiplexEventSource(options: WatchMultiplexOpenOptions): EventSource {
  const canonicalPath = readMultiplexedWatchPath(options.path);
  if (
    !canonicalPath
    || options.target.isRemote
    || !options.isTargetStillValid()
    || typeof window === 'undefined'
    || typeof WebSocket === 'undefined'
  ) {
    return options.createSseFallback();
  }

  const wsUrl = buildSameOriginWatchWebSocketUrl(options.origin);
  const registryKey = `${wsUrl}|${options.target.scopeKey}`;
  const sourceId = allocateSourceId();

  // Bind a lazy bridge so constructing a source that is closed before its
  // attach microtask never creates a client or opens an empty WebSocket.
  let boundClient: WatchMultiplexClient | null = null;
  const lazyBridge: WatchMultiplexClientBridge = {
    attach(source) {
      if (!options.isTargetStillValid()) {
        source.forceCloseFromClient();
        return;
      }
      let client = clientsByScope.get(registryKey) || null;
      if (!client) {
        client = new WatchMultiplexClient(
          registryKey,
          wsUrl,
          options,
          removeClientFromRegistry,
        );
        clientsByScope.set(registryKey, client);
      }
      boundClient = client;
      client.attach(source);
    },
    detach(source) {
      boundClient?.detach(source);
      boundClient = null;
    },
    requestResubscribe(source) {
      boundClient?.requestResubscribe(source);
    },
  };

  return new WatchMultiplexEventSource(
    sourceId,
    canonicalPath,
    options.createSseFallback,
    lazyBridge,
  ) as unknown as EventSource;
}
