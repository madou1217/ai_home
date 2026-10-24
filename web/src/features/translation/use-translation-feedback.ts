import { useEffect, useState } from 'react';
import type { TranslationStreamState } from './translation-stream-reducer';

/** 呈现层只派生反馈，不持有请求或改变翻译状态。 */
export function useTranslationFeedback(state: TranslationStreamState, preparing = false, sameLanguage = false) {
  const active = preparing || state.status === 'streaming';
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    if (!active) return;
    const startedAt = performance.now();
    setElapsedMs(0);
    const timer = window.setInterval(() => setElapsedMs(performance.now() - startedAt), 250);
    return () => window.clearInterval(timer);
  }, [active, state.request]);

  const phase = preparing ? 'preparing' : sameLanguage ? 'same-language'
    : state.status === 'streaming' ? (state.text ? 'streaming' : 'waiting') : state.status;
  const slow = active && elapsedMs >= 6000;
  const latestAttempt = state.attempts[state.attempts.length - 1];
  const labels = {
    preparing: '准备翻译',
    'same-language': '无需翻译',
    waiting: slow ? '仍在等待译文' : '正在翻译',
    streaming: '正在生成译文',
    done: '翻译完成',
    cancelled: '已停止',
    error: '翻译失败',
    idle: '等待翻译',
  };
  return {
    phase,
    active,
    slow,
    label: labels[phase],
    elapsedLabel: `${((active ? elapsedMs : state.elapsedMs || elapsedMs) / 1000).toFixed(1)}s`,
    hint: preparing ? '识别语言并准备模型'
      : active && latestAttempt && latestAttempt.attempt > 1 ? `正在尝试第 ${latestAttempt.attempt} 条路由 · ${latestAttempt.model}`
      : slow ? '模型响应较慢，你可以继续等待或停止'
        : '译文即将出现，生成后会实时显示',
  };
}
