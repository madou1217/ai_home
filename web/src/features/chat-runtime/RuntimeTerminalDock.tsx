import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionProjection, SessionProjectionStore, TimelineItem } from '@/chat-runtime';
import { useSessionSelector } from '@/chat-runtime';
import TerminalDock from '@/components/chat/TerminalDock';
import { chatAPI } from '@/services/api';

// 交互终端（由 legacy MessageArea 的 TerminalDock 迁入 canonical）：
// slash 命令 / TUI 轮次在时间线里有一条 terminal 条目（detail.terminalId = 引擎 run id）。
// 运行中时把它的输出接进 xterm，按键与尺寸经 /v0/webui/chat/runs/:runId/input|resize 写回 CLI 的 PTY
// （与 legacy 同一条通道；服务端由原生驱动登记 run，见 native-session-driver.registerEngineRun）。
// 输出以「已写入长度」增量喂给 xterm，不经过 React state，流式时不触发重渲染。

type TerminalItem = Extract<TimelineItem, { kind: 'terminal' }>;

interface ActiveTerminal {
  readonly itemId: string;
  readonly runId: string;
  readonly running: boolean;
}

function selectActiveTerminal(projection: SessionProjection): ActiveTerminal | null {
  for (let index = projection.items.length - 1; index >= 0; index -= 1) {
    const item = projection.items[index];
    if (item.kind !== 'terminal') continue;
    const terminal = item as TerminalItem;
    const runId = terminal.detail.terminalId || '';
    if (!runId) return null;
    return { itemId: terminal.id, runId, running: terminal.status === 'running' };
  }
  return null;
}

function sameTerminal(a: ActiveTerminal | null, b: ActiveTerminal | null): boolean {
  return a === b || Boolean(a && b && a.itemId === b.itemId && a.runId === b.runId && a.running === b.running);
}

export default function RuntimeTerminalDock({ store, command }: {
  readonly store: SessionProjectionStore;
  readonly command?: string;
}) {
  const terminal = useSessionSelector(store, selectActiveTerminal, sameTerminal);
  const [dismissed, setDismissed] = useState<string>('');
  const writerRef = useRef<((data: string) => void) | null>(null);
  const writtenRef = useRef(0);

  // 输出增量：直接订阅 store，按已写入长度把新增内容写进 xterm。
  useEffect(() => {
    writtenRef.current = 0;
    if (!terminal) return undefined;
    const flush = (): void => {
      const writer = writerRef.current;
      if (!writer) return;
      const item = store.getSnapshot().items.find((entry) => entry.id === terminal.itemId);
      const content = item?.content || '';
      if (content.length > writtenRef.current) {
        writer(content.slice(writtenRef.current));
        writtenRef.current = content.length;
      }
    };
    flush();
    return store.subscribe(flush);
  }, [store, terminal?.itemId]);

  const registerWriter = useCallback((_runId: string, writer: ((data: string) => void) | null): void => {
    writerRef.current = writer;
    writtenRef.current = 0;
    if (writer && terminal) {
      const item = store.getSnapshot().items.find((entry) => entry.id === terminal.itemId);
      const content = item?.content || '';
      if (content) writer(content);
      writtenRef.current = content.length;
    }
  }, [store, terminal]);
  const sendInput = useCallback((runId: string, data: string): void => {
    if (!terminal?.running) return;
    void chatAPI.sendRunInput(runId, data, false).catch(() => {});
  }, [terminal?.running]);
  const resize = useCallback((runId: string, cols: number, rows: number): void => {
    if (!terminal?.running) return;
    void chatAPI.resizeRunTerminal(runId, cols, rows).catch(() => {});
  }, [terminal?.running]);

  if (!terminal || dismissed === terminal.itemId) return null;
  return (
    <TerminalDock
      key={terminal.itemId}
      visible
      run={{ runId: terminal.runId, command: command || 'terminal', active: terminal.running }}
      onRegisterWriter={registerWriter}
      onInput={sendInput}
      onResize={resize}
      onClose={() => setDismissed(terminal.itemId)}
    />
  );
}
