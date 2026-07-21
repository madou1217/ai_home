import assert from 'node:assert/strict';
import test from 'node:test';
import type { TimelineItem } from '@/chat-runtime';
import {
  BrowserFirstTextPaintProbe,
  FIRST_TEXT_PAINT_MEASURE,
} from './browser-first-text-paint-probe';
import type {
  PaintScheduler,
  PerformanceTimelinePort,
} from './browser-first-text-paint-probe';

function createFixture() {
  const marks: string[] = [];
  const measures: Array<{ name: string; start: string; end: string }> = [];
  const scheduled: Array<() => void> = [];
  const cancelled = new Set<() => void>();
  const performance: PerformanceTimelinePort = {
    mark: (name) => { marks.push(name); },
    measure: (name, start, end) => { measures.push({ name, start, end }); },
    clearMark: () => {},
  };
  const scheduler: PaintScheduler = {
    afterNextPaint(callback) {
      scheduled.push(callback);
      return () => { cancelled.add(callback); };
    },
  };
  const probe = new BrowserFirstTextPaintProbe('session-1', {
    performance,
    scheduler,
  });
  return {
    marks,
    measures,
    probe,
    flushPaint() {
      const callback = scheduled.shift();
      if (callback && !cancelled.has(callback)) callback();
    },
    scheduledCount: () => scheduled.length,
  };
}

test('probe measures the first newly appended assistant text after a turn dispatch', () => {
  const fixture = createFixture();
  fixture.probe.observeCommittedTimeline([
    message('old-assistant', 'assistant', 'old response'),
  ]);

  fixture.probe.onCommandDispatch({ commandId: 'command-1', type: 'turn.submit' });
  fixture.probe.observeCommittedTimeline([
    message('old-assistant', 'assistant', 'old response'),
    message('user-1', 'user', 'new request'),
    reasoning('reasoning-1', 'thinking'),
    message('assistant-1', 'assistant', ''),
  ]);
  assert.equal(fixture.scheduledCount(), 0);

  fixture.probe.observeCommittedTimeline([
    message('old-assistant', 'assistant', 'old response'),
    message('user-1', 'user', 'new request'),
    reasoning('reasoning-1', 'thinking'),
    message('assistant-1', 'assistant', 'first word'),
  ]);
  assert.equal(fixture.scheduledCount(), 1);
  assert.equal(fixture.measures.length, 0);

  fixture.flushPaint();

  assert.equal(fixture.measures.length, 1);
  assert.equal(fixture.measures[0].name, FIRST_TEXT_PAINT_MEASURE);
  assert.match(fixture.measures[0].start, /command-1/);
  assert.match(fixture.measures[0].end, /command-1/);
  assert.equal(fixture.marks.length, 2);
});

test('probe never treats prepended history as a new assistant response', () => {
  const fixture = createFixture();
  fixture.probe.observeCommittedTimeline([
    message('visible-tail', 'user', 'current request'),
  ]);
  fixture.probe.onCommandDispatch({ commandId: 'command-1', type: 'turn.submit' });

  fixture.probe.observeCommittedTimeline([
    message('older-assistant', 'assistant', 'loaded history'),
    message('visible-tail', 'user', 'current request'),
  ]);

  assert.equal(fixture.scheduledCount(), 0);
  assert.equal(fixture.measures.length, 0);
});

test('probe ignores non-turn commands and cancels a rejected turn dispatch', () => {
  const fixture = createFixture();
  fixture.probe.observeCommittedTimeline([]);
  fixture.probe.onCommandDispatch({ commandId: 'queue-1', type: 'queue.add' });
  fixture.probe.observeCommittedTimeline([
    message('assistant-ignored', 'assistant', 'not a submitted turn'),
  ]);
  assert.equal(fixture.scheduledCount(), 0);

  fixture.probe.onCommandDispatch({ commandId: 'command-1', type: 'turn.submit' });
  fixture.probe.onCommandDispatchFailed({ commandId: 'command-1', type: 'turn.submit' });
  fixture.probe.observeCommittedTimeline([
    message('assistant-failed', 'assistant', 'late response'),
  ]);

  assert.equal(fixture.scheduledCount(), 0);
  assert.equal(fixture.measures.length, 0);
});

test('probe records at most one paint measure per submitted turn', () => {
  const fixture = createFixture();
  fixture.probe.observeCommittedTimeline([]);
  fixture.probe.onCommandDispatch({ commandId: 'command-1', type: 'turn.submit' });
  const first = [message('assistant-1', 'assistant', 'first')];

  fixture.probe.observeCommittedTimeline(first);
  fixture.probe.observeCommittedTimeline([
    message('assistant-1', 'assistant', 'first and second'),
  ]);
  assert.equal(fixture.scheduledCount(), 1);
  fixture.flushPaint();
  fixture.probe.observeCommittedTimeline([
    message('assistant-1', 'assistant', 'complete response'),
  ]);

  assert.equal(fixture.measures.length, 1);
  assert.equal(fixture.scheduledCount(), 0);
});

function message(
  id: string,
  role: 'user' | 'assistant',
  content: string,
): TimelineItem {
  return {
    id,
    kind: 'message',
    createdAt: 1,
    status: 'completed',
    content,
    detail: { role },
  };
}

function reasoning(id: string, content: string): TimelineItem {
  return {
    id,
    kind: 'reasoning',
    createdAt: 1,
    status: 'running',
    content,
    detail: {},
  };
}
