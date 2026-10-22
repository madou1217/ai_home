import { describe, expect, test } from 'bun:test';
import {
  beginTranslationStream,
  createInitialTranslationStreamState,
  reduceTranslationStream,
} from './translation-stream-reducer';

const request = { text: 'hello', source: 'auto', target: 'zh-Hans' };

describe('translation stream reducer', () => {
  test('starts idle', () => {
    const state = createInitialTranslationStreamState();
    expect(state.status).toBe('idle');
    expect(state.text).toBe('');
    expect(state.meta).toBeNull();
    expect(state.error).toBeNull();
    expect(state.request).toBeNull();
  });

  test('begin immediately switches to streaming and keeps the request', () => {
    const state = reduceTranslationStream(createInitialTranslationStreamState(), {
      type: 'begin',
      request,
    });
    expect(state.status).toBe('streaming');
    expect(state.request).toEqual(request);
    expect(state.text).toBe('');
  });

  test('start records languages, detection and model', () => {
    const state = reduceTranslationStream(
      beginTranslationStream(request),
      {
        type: 'event',
        event: {
          type: 'start',
          from: 'en',
          fromLabel: '英语',
          detected: 'en',
          detectedLabel: '英语',
          detectionConfidence: 'high',
          to: 'zh-Hans',
          toLabel: '简体中文',
          model: 'claude-sonnet-4',
          provider: 'claude',
        },
      },
    );
    expect(state.status).toBe('streaming');
    expect(state.meta?.fromLabel).toBe('英语');
    expect(state.meta?.toLabel).toBe('简体中文');
    expect(state.meta?.detectionConfidence).toBe('high');
    expect(state.meta?.model).toBe('claude-sonnet-4');
  });

  test('delta appends without reordering and ignores empty chunks', () => {
    let state = beginTranslationStream(request);
    state = reduceTranslationStream(state, { type: 'event', event: { type: 'delta', content: '你' } });
    state = reduceTranslationStream(state, { type: 'event', event: { type: 'delta', content: '好' } });
    const before = state;
    state = reduceTranslationStream(state, { type: 'event', event: { type: 'delta', content: '' } });
    expect(state).toBe(before);
    expect(state.text).toBe('你好');
    expect(state.status).toBe('streaming');
  });

  test('done replaces the accumulated text with the final payload', () => {
    let state = beginTranslationStream(request);
    state = reduceTranslationStream(state, { type: 'event', event: { type: 'delta', content: '你好 ' } });
    state = reduceTranslationStream(state, {
      type: 'event',
      event: { type: 'done', text: '你好', usage: { total_tokens: 12 }, elapsedMs: 640 },
    });
    expect(state.status).toBe('done');
    // 服务端最终文本优先：可以修掉多余空白
    expect(state.text).toBe('你好');
    expect(state.usage).toEqual({ total_tokens: 12 });
    expect(state.elapsedMs).toBe(640);
  });

  test('done keeps accumulated text when the payload is empty', () => {
    let state = beginTranslationStream(request);
    state = reduceTranslationStream(state, { type: 'event', event: { type: 'delta', content: 'abc' } });
    state = reduceTranslationStream(state, {
      type: 'event',
      event: { type: 'done', text: '', usage: null, elapsedMs: 100 },
    });
    expect(state.status).toBe('done');
    expect(state.text).toBe('abc');
  });

  test('error keeps partial text so the user does not lose what was shown', () => {
    let state = beginTranslationStream(request);
    state = reduceTranslationStream(state, { type: 'event', event: { type: 'delta', content: '部分' } });
    state = reduceTranslationStream(state, {
      type: 'event',
      event: {
        type: 'error',
        code: 'upstream_failed',
        message: '上游返回 502',
        status: 502,
        partialText: '部分译文',
        elapsedMs: 900,
      },
    });
    expect(state.status).toBe('error');
    expect(state.text).toBe('部分译文');
    expect(state.error).toEqual({ code: 'upstream_failed', message: '上游返回 502', status: 502 });
    expect(state.elapsedMs).toBe(900);
  });

  test('transport failure keeps partial deltas and reports a stable code', () => {
    let state = beginTranslationStream(request);
    state = reduceTranslationStream(state, { type: 'event', event: { type: 'delta', content: 'ab' } });
    state = reduceTranslationStream(state, { type: 'fail', message: '网络中断' });
    expect(state.status).toBe('error');
    expect(state.text).toBe('ab');
    expect(state.error).toEqual({
      code: 'translation_stream_failed',
      message: '网络中断',
      status: 0,
    });
  });

  test('fail on an idle state is a no-op', () => {
    const state = createInitialTranslationStreamState();
    expect(reduceTranslationStream(state, { type: 'fail', message: 'x' })).toBe(state);
  });

  test('cancel stops streaming but keeps the received text', () => {
    let state = beginTranslationStream(request);
    state = reduceTranslationStream(state, { type: 'event', event: { type: 'delta', content: '保留' } });
    state = reduceTranslationStream(state, { type: 'cancel' });
    expect(state.status).toBe('cancelled');
    expect(state.text).toBe('保留');
  });

  test('cancel outside streaming is a no-op', () => {
    const done = reduceTranslationStream(beginTranslationStream(request), {
      type: 'event',
      event: { type: 'done', text: 'ok', usage: null, elapsedMs: 1 },
    });
    expect(reduceTranslationStream(done, { type: 'cancel' })).toBe(done);
  });

  test('reset clears every field', () => {
    let state = beginTranslationStream(request);
    state = reduceTranslationStream(state, { type: 'event', event: { type: 'delta', content: 'x' } });
    const reset = reduceTranslationStream(state, { type: 'reset' });
    expect(reset).toEqual(createInitialTranslationStreamState());
  });
});
