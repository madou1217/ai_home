// 流式翻译的状态归约（纯函数，不碰 DOM / 网络）。
//
// 服务的 SSE 事件只有四种：start / delta / done / error。这里把它们折进一个
// 可渲染的状态对象，页面与悬浮窗共用同一套规则：
//   - delta 只追加，绝不重排（模型可能分段吐同一个词）；
//   - done 用服务端最终文本覆盖累积结果（去掉可能被追加的空白/重复）；
//   - error 保留 partialText，用户已经看到的那部分不能因为失败而消失；
//   - 用户取消（cancelled）保留已收到的增量，语义是「停在这里，别清空」。

import type {
  TranslationStreamEvent,
  TranslationStreamRequest,
} from '@/types';

export type TranslationStreamStatus = 'idle' | 'streaming' | 'done' | 'error' | 'cancelled';

export interface TranslationStreamMeta {
  from: string;
  fromLabel: string;
  detected: string;
  detectedLabel: string;
  detectionConfidence: 'high' | 'medium' | 'low';
  to: string;
  toLabel: string;
  model: string;
  provider: string;
}

export interface TranslationStreamError {
  code: string;
  message: string;
  status: number;
}

export interface TranslationStreamState {
  status: TranslationStreamStatus;
  /** 当前累计译文 */
  text: string;
  /** start 事件带来的语言/模型信息；首字节前为 null */
  meta: TranslationStreamMeta | null;
  usage: Record<string, unknown> | null;
  elapsedMs: number;
  error: TranslationStreamError | null;
  /** 本次请求对应的原文（复制/重试时用来判断结果是否已过期） */
  request: TranslationStreamRequest | null;
}

export type TranslationStreamAction =
  | { type: 'reset' }
  | { type: 'begin'; request: TranslationStreamRequest }
  | { type: 'event'; event: TranslationStreamEvent }
  | { type: 'fail'; message: string; status?: number }
  | { type: 'cancel' };

export function createInitialTranslationStreamState(): TranslationStreamState {
  return {
    status: 'idle',
    text: '',
    meta: null,
    usage: null,
    elapsedMs: 0,
    error: null,
    request: null,
  };
}

/** 发起请求时立刻进入 streaming：UI 可以马上显示「翻译中」而不是等首个字节。 */
export function beginTranslationStream(
  request: TranslationStreamRequest,
): TranslationStreamState {
  return {
    ...createInitialTranslationStreamState(),
    status: 'streaming',
    request,
  };
}

export function reduceTranslationStream(
  state: TranslationStreamState,
  action: TranslationStreamAction,
): TranslationStreamState {
  if (action.type === 'reset') return createInitialTranslationStreamState();
  if (action.type === 'begin') return beginTranslationStream(action.request);

  if (action.type === 'fail') {
    if (state.status === 'idle') return state;
    return {
      ...state,
      status: 'error',
      error: {
        code: 'translation_stream_failed',
        message: action.message || '翻译请求失败',
        status: Number(action.status) || 0,
      },
    };
  }

  if (action.type === 'cancel') {
    if (state.status !== 'streaming') return state;
    return { ...state, status: 'cancelled' };
  }

  const event = action.event;
  if (event.type === 'start') {
    return {
      ...state,
      status: 'streaming',
      meta: {
        from: event.from,
        fromLabel: event.fromLabel,
        detected: event.detected,
        detectedLabel: event.detectedLabel,
        detectionConfidence: event.detectionConfidence,
        to: event.to,
        toLabel: event.toLabel,
        model: event.model,
        provider: event.provider,
      },
    };
  }

  if (event.type === 'delta') {
    const content = String(event.content || '');
    if (!content) return state;
    return { ...state, status: 'streaming', text: state.text + content };
  }

  if (event.type === 'done') {
    const finalText = String(event.text ?? '');
    return {
      ...state,
      status: 'done',
      text: finalText || state.text,
      usage: event.usage || null,
      elapsedMs: Number(event.elapsedMs) || 0,
    };
  }

  // error
  return {
    ...state,
    status: 'error',
    text: String(event.partialText || '') || state.text,
    elapsedMs: Number(event.elapsedMs) || 0,
    error: {
      code: event.code || 'translation_failed',
      message: event.message || '翻译失败',
      status: Number(event.status) || 0,
    },
  };
}
