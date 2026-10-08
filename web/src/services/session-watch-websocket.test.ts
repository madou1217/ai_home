import { afterEach, beforeEach, expect, test } from 'bun:test';
import { readSessionWatchTarget, SessionWatchWebSocketSource } from './session-watch-websocket';

class FakeWebSocket {
  static opened: FakeWebSocket[] = [];
  readonly sent: string[] = [];
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: Event) => void) | null = null;
  closed = false;

  constructor(readonly url: string) { FakeWebSocket.opened.push(this); }
  send(data: string): void { this.sent.push(data); }
  close(): void { this.closed = true; this.onclose?.(new Event('close')); }
  open(): void { this.onopen?.(new Event('open')); }
  receive(payload: unknown): void { this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(payload) })); }
}

const originalWebSocket = globalThis.WebSocket;
const sources: SessionWatchWebSocketSource[] = [];
const target = { provider: 'workbuddycn', sessionId: 'native-id', projectDirName: 'project' };
const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve));
const source = (readManagementKey = () => 'management-key', origin = 'http://127.0.0.1:9527') => {
  const next = new SessionWatchWebSocketSource({ origin, target, readManagementKey });
  sources.push(next);
  return next;
};

beforeEach(() => {
  FakeWebSocket.opened = [];
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
});
afterEach(() => {
  sources.splice(0).forEach((item) => item.close());
  globalThis.WebSocket = originalWebSocket;
});

test('only complete native session watches select the WebSocket transport', () => {
  expect(readSessionWatchTarget('/v0/webui/sessions/watch?provider=workbuddycn&sessionId=native-id&projectDirName=project')).toEqual(target);
  expect(readSessionWatchTarget('/v0/webui/projects/watch')).toBeNull();
  expect(readSessionWatchTarget('/v0/webui/sessions/watch?provider=workbuddy')).toBeNull();
});

test('Management Key is read when the socket opens and travels only in the first frame', async () => {
  let key = 'initial-key';
  const stream = source(() => key);
  await flush();
  const socket = FakeWebSocket.opened[0];
  key = 'current-management-key';
  socket.open();
  expect(stream.url).toBe('ws://127.0.0.1:9527/v0/webui/sessions/watch/ws');
  expect(stream.url.includes(key)).toBe(false);
  expect(stream.url.includes('native-id')).toBe(false);
  expect(socket.sent.map((frame) => JSON.parse(frame))).toEqual([{ authorization: `Bearer ${key}`, ...target }]);
  expect(stream.readyState).toBe(stream.CONNECTING);
});

test('only the authenticated connected frame opens the source and native events stay intact', async () => {
  const stream = source();
  let opens = 0;
  const messages: unknown[] = [];
  stream.onopen = () => { opens += 1; };
  stream.onmessage = (event) => messages.push(JSON.parse(event.data));
  await flush();
  const socket = FakeWebSocket.opened[0];
  socket.open();
  socket.receive({ type: 'update', phase: 'complete' });
  expect(opens).toBe(0);
  expect(messages).toEqual([]);
  const update = { type: 'update', runId: 'run', phase: 'waiting-input', promptId: 'prompt', prompt: { options: ['yes'] }, retryStatus: { attempt: 2 } };
  socket.receive({ type: 'connected' });
  socket.receive(update);
  expect(opens).toBe(1);
  expect(stream.readyState).toBe(stream.OPEN);
  expect(messages).toEqual([{ type: 'connected' }, update]);
});

test('HTTPS origins use secure WebSockets without adding credential query parameters', async () => {
  const stream = source(() => 'management-key', 'https://aih.example:9443');
  await flush();
  expect(stream.url).toBe('wss://aih.example:9443/v0/webui/sessions/watch/ws');
});

test('closing before connection prevents a background socket from opening', async () => {
  const stream = source();
  stream.close();
  await flush();
  expect(FakeWebSocket.opened).toEqual([]);
  expect(stream.readyState).toBe(stream.CLOSED);
});

test('consumer close on error cancels reconnect and stale socket events', async () => {
  const stream = source();
  let failures = 0;
  let messages = 0;
  stream.onerror = () => { failures += 1; stream.close(); };
  stream.onmessage = () => { messages += 1; };
  await flush();
  const socket = FakeWebSocket.opened[0];
  socket.close();
  socket.receive({ type: 'connected' });
  expect(failures).toBe(1);
  expect(messages).toBe(0);
  expect(stream.readyState).toBe(stream.CLOSED);
});

test('an interrupted connection retries once and reads the latest key', async () => {
  let key = 'old-key';
  const stream = source(() => key);
  let failures = 0;
  stream.onerror = () => { failures += 1; };
  await flush();
  const socket = FakeWebSocket.opened[0];
  socket.onerror?.(new Event('error'));
  socket.close();
  key = 'refreshed-key';
  await new Promise((resolve) => setTimeout(resolve, 1050));
  expect(failures).toBe(1);
  expect(FakeWebSocket.opened.length).toBe(2);
  FakeWebSocket.opened[1].open();
  expect(JSON.parse(FakeWebSocket.opened[1].sent[0]).authorization).toBe('Bearer refreshed-key');
});
