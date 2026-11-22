import {
  fetchAuthorizedWebUiResource,
  isTransportTargetStillValid,
  resolveActiveTransportTarget,
  subscribeTransportTargetChange,
  type WebUiTransportTarget,
} from '@/services/webui-auth-transport';

export interface BrowserSurfaceEvent {
  type: string;
  frame?: number;
  data?: string;
  error?: string;
  width?: number;
  height?: number;
  controlToken?: string;
}

export interface BrowserCapabilities {
  supported: boolean;
  scope?: string;
  scopes?: string[];
  hostOS?: string;
  hostArch?: string;
  reason?: string;
  capture?: boolean;
  pointer?: boolean;
  scroll?: boolean;
  text?: boolean;
  requiresUserStart?: boolean;
  mayActivateNativeWindow?: boolean;
  permissions?: string;
  browser?: { vendor: string; channel: string };
  transports?: string[];
}

const basePath = '/v0/webui/account-browser/live';
const maxEventBytes = 2 * 1024 * 1024;
const maxCommandBytes = 8 * 1024;

// A bound transport never follows a changed selection to another execution
// host. Endpoints/keys are resolved by existing authenticated server routing.
function isCurrent(target: WebUiTransportTarget) {
  return isTransportTargetStillValid(target)
    && resolveActiveTransportTarget().scopeKey === target.scopeKey;
}

export async function readBrowserCapabilities(signal?: AbortSignal): Promise<BrowserCapabilities> {
  const target = resolveActiveTransportTarget();
  const response = await fetchAuthorizedWebUiResource(`${basePath}/capabilities`, {
    cache: 'no-store', signal,
  }, target);
  if (!response.ok) throw new Error(`browser_capabilities_http_${response.status}`);
  const caps = await response.json();
  if (!isCurrent(target)) throw new Error('browser_server_changed');
  if (typeof caps?.supported !== 'boolean') throw new Error('browser_capabilities_invalid');
  return caps;
}

export type BrowserSurfaceScope = {
  scope?: 'task' | 'account' | 'job';
  provider?: string;
  accountRef?: string;
  authJob?: string;
};

export function connectBrowserSurface(
  onEvent: (event: BrowserSurfaceEvent) => void,
  onClose: () => void,
  requestedScope: BrowserSurfaceScope = {},
) {
  const target = resolveActiveTransportTarget();
  const controller = new AbortController();
  let closed = false;
  let token = '';
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let unsubscribe = () => {};
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const queue: Record<string, unknown>[] = [];
  let publishing = false;
  let inFlight = false;

  const close = () => {
    if (closed) return;
    closed = true;
    token = '';
    queue.length = 0;
    if (idleTimer) clearTimeout(idleTimer);
    unsubscribe();
    controller.abort();
    void reader?.cancel().catch(() => {});
    onClose();
  };
  const fail = (error: unknown) => {
    if (closed) return;
    onEvent({ type: 'error', error: error instanceof Error ? error.message : 'browser_connection_failed' });
    close();
  };
  const refreshIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => fail(new Error('browser_stream_timeout')), 20000);
  };

  unsubscribe = subscribeTransportTargetChange(() => { if (!isCurrent(target)) close(); });

  // Strictly serial command POSTs preserve order across separate HTTP requests.
  // Never retry an ambiguous acknowledgement: that could double-type/click.
  const publish = async () => {
    if (publishing || closed) return;
    publishing = true;
    try {
      while (queue.length && !closed) {
        if (!isCurrent(target) || !token) { close(); break; }
        const body = JSON.stringify(queue.shift()!);
        inFlight = true;
        const commandController = new AbortController();
        const cancel = () => commandController.abort();
        controller.signal.addEventListener('abort', cancel, { once: true });
        const timeout = setTimeout(cancel, 5000);
        try {
          const response = await fetchAuthorizedWebUiResource(`${basePath}/command`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'X-AIH-Browser-Session': token },
            body,
            signal: commandController.signal,
            cache: 'no-store',
          }, target);
          void response.body?.cancel().catch(() => {});
          if (!response.ok) throw new Error(`browser_command_http_${response.status}`);
          if (!isCurrent(target)) close();
        } finally {
          inFlight = false;
          clearTimeout(timeout);
          controller.signal.removeEventListener('abort', cancel);
        }
      }
    } catch (error) { fail(error); }
    finally { publishing = false; }
  };

  const send = (command: Record<string, unknown>) => {
    if (closed || !token || !isCurrent(target)) { if (!closed && !isCurrent(target)) close(); return false; }
    const body = JSON.stringify(command);
    if (new TextEncoder().encode(body).byteLength > maxCommandBytes) return false;
    // Adjacent unsent scroll movements may be coalesced, never clicks/text or
    // anything across an intervening command. Keep a bounded latest intent.
    const tail = queue[queue.length - 1];
    if (command.type === 'scroll' && tail?.type === 'scroll') {
      const clamp = (value: number) => Math.max(-2000, Math.min(2000, value));
      tail.deltaX = clamp(Number(tail.deltaX || 0) + Number(command.deltaX || 0));
      tail.deltaY = clamp(Number(tail.deltaY || 0) + Number(command.deltaY || 0));
      tail.frame = command.frame;
    } else {
      if (queue.length + Number(inFlight) >= 8) { fail(new Error('browser_control_backpressure')); return false; }
      queue.push({ ...command });
    }
    void publish();
    return true;
  };

  void (async () => {
    refreshIdle();
    try {
      if (!isCurrent(target)) { close(); return; }
      const scopeBody: BrowserSurfaceScope = requestedScope.scope === 'account'
        ? { scope: 'account', provider: requestedScope.provider, accountRef: requestedScope.accountRef }
        : requestedScope.scope === 'job'
          ? { scope: 'job', authJob: requestedScope.authJob }
          : { scope: 'task' };
      const response = await fetchAuthorizedWebUiResource(`${basePath}/stream`, {
        method: 'POST', body: JSON.stringify(scopeBody),
        headers: { 'content-type': 'application/json' },
        cache: 'no-store', signal: controller.signal,
      }, target);
      if (closed || !isCurrent(target)) { void response.body?.cancel().catch(() => {}); close(); return; }
      if (!response.ok || !response.body) throw new Error(`browser_stream_http_${response.status}`);
      reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let line = '';
      let lineBytes = 0;
      const receiveLine = () => {
        line += decoder.decode(); // Finish UTF-8 validation for this event.
        const event: BrowserSurfaceEvent = JSON.parse(line);
        line = '';
        lineBytes = 0;
        if (!event || typeof event.type !== 'string') throw new Error('browser_event_invalid');
        refreshIdle();
        if (event.type === 'session') {
          if (token || !/^[a-f0-9]{64}$/.test(event.controlToken || '')) throw new Error('browser_control_lease_invalid');
          token = event.controlToken!;
        } else {
          if (!token) throw new Error('browser_control_lease_missing');
          if (event.type !== 'heartbeat') onEvent(event);
        }
      };
      while (!closed) {
        const { value, done } = await reader.read();
        if (closed || !isCurrent(target)) { close(); return; }
        if (done) break;
        // Bound UTF-8 bytes per EVENT, not TCP/fetch chunks. A single chunk
        // may contain many valid events; a codepoint may span two chunks.
        let offset = 0;
        while (offset < value.byteLength) {
          const newline = value.indexOf(10, offset);
          const end = newline < 0 ? value.byteLength : newline;
          const part = value.subarray(offset, end);
          lineBytes += part.byteLength;
          if (lineBytes > maxEventBytes) throw new Error('browser_event_too_large');
          line += decoder.decode(part, { stream: true });
          offset = end + (newline < 0 ? 0 : 1);
          if (newline >= 0) receiveLine();
          if (closed) return;
        }
      }
      decoder.decode(); // Detect an incomplete final multibyte character.
      if (lineBytes) throw new Error('browser_event_truncated');
      close();
    } catch (error) { fail(error); }
    finally { try { reader?.releaseLock(); } catch (_) { /* cancellation already owns the reader */ } }
  })();

  return { send, close };
}
