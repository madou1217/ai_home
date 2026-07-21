import assert from 'node:assert/strict';
import test from 'node:test';
import type { TimelineItem } from '@/chat-runtime';
import {
  BrowserFirstTextPaintProbe,
  FIRST_TEXT_PAINT_MEASURE,
} from './browser-first-text-paint-probe';
import type { RuntimeCommandNotice } from './runtime-command-observer';

function assistant(id: string, content: string): TimelineItem {
  return {
    id,
    kind: 'message',
    status: 'completed',
    createdAt: 1,
    content,
    detail: { role: 'assistant' },
  };
}

function submit(commandId: string): RuntimeCommandNotice {
  return { commandId, type: 'turn.submit' };
}

function fixture() {
  const marks: string[] = [];
  const measures: Array<{ name: string; start: string; end: string }> = [];
  const pendingPaints: Array<() => void> = [];
  const clearedMarks: string[] = [];
  const probe = new BrowserFirstTextPaintProbe('session-1', {
    performance: {
      mark(name) { marks.push(name); },
      measure(name, start, end) { measures.push({ name, start, end }); },
      clearMark(name) { clearedMarks.push(name); },
    },
    scheduler: {
      afterNextPaint(callback) {
        pendingPaints.push(callback);
        return () => {
          const index = pendingPaints.indexOf(callback);
          if (index >= 0) pendingPaints.splice(index, 1);
        };
      },
    },
  });
  return { clearedMarks, marks, measures, pendingPaints, probe };
}

test('probe ignores an existing assistant item whose content changes after dispatch', () => {
  const state = fixture();
  state.probe.observeCommittedTimeline([assistant('assistant-existing', '')]);
  state.probe.onCommandDispatch(submit('command-1'));

  state.probe.observeCommittedTimeline([assistant('assistant-existing', 'late history')]);

  assert.equal(state.pendingPaints.length, 0);
  assert.equal(state.measures.length, 0);
});

test('a newer turn cancels a scheduled sample and measures only its own paint', () => {
  const state = fixture();
  state.probe.observeCommittedTimeline([]);
  state.probe.onCommandDispatch(submit('command-1'));
  const first = assistant('assistant-first', 'first response');
  state.probe.observeCommittedTimeline([first]);
  assert.equal(state.pendingPaints.length, 1);

  state.probe.onCommandDispatch(submit('command-2'));
  assert.equal(state.pendingPaints.length, 0);
  const second = assistant('assistant-second', 'second response');
  state.probe.observeCommittedTimeline([first, second]);
  assert.equal(state.pendingPaints.length, 1);

  state.pendingPaints.shift()?.();

  assert.equal(state.measures.length, 1);
  assert.equal(state.measures[0].name, FIRST_TEXT_PAINT_MEASURE);
  assert.match(state.measures[0].start, /command-2/);
  assert.equal(state.clearedMarks.length, 4);
});
