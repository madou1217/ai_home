// 翻译页与悬浮窗共用的两个 hook：设置引导（settings/languages/models）与流式请求。

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { translationAPI } from '@/services/api';
import type { TranslationStreamRequest } from '@/types';
import {
  createInitialTranslationStreamState,
  reduceTranslationStream,
  type TranslationStreamState,
} from './translation-stream-reducer';
import {
  getTranslationBootstrap,
  loadTranslationBootstrap,
  subscribeTranslationBootstrap,
  type TranslationBootstrap,
} from './translation-settings-store';

export interface TranslationBootstrapState {
  status: 'loading' | 'ready' | 'error';
  bootstrap: TranslationBootstrap | null;
  error: string;
  reload: () => void;
}

export function useTranslationBootstrap(): TranslationBootstrapState {
  const [bootstrap, setBootstrap] = useState<TranslationBootstrap | null>(
    () => getTranslationBootstrap(),
  );
  const [error, setError] = useState('');
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let alive = true;
    const unsubscribe = subscribeTranslationBootstrap((next) => {
      if (!alive) return;
      setBootstrap(next);
      setError('');
    });
    loadTranslationBootstrap(reloadToken > 0)
      .then((next) => {
        if (alive) setBootstrap(next);
      })
      .catch((loadError) => {
        if (!alive) return;
        setError(loadError?.message || '加载翻译设置失败');
      });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [reloadToken]);

  const reload = useCallback(() => {
    setReloadToken((token) => token + 1);
  }, []);

  return {
    status: bootstrap ? 'ready' : error ? 'error' : 'loading',
    bootstrap,
    error,
    reload,
  };
}

export interface TranslationStreamController {
  state: TranslationStreamState;
  busy: boolean;
  run: (request: TranslationStreamRequest) => Promise<void>;
  cancel: () => void;
  reset: () => void;
}

export function useTranslationStream(): TranslationStreamController {
  const [state, dispatch] = useReducer(
    reduceTranslationStream,
    undefined,
    createInitialTranslationStreamState,
  );
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => () => {
    controllerRef.current?.abort();
    controllerRef.current = null;
  }, []);

  const run = useCallback(async (request: TranslationStreamRequest) => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    dispatch({ type: 'begin', request });
    try {
      await translationAPI.stream(request, {
        signal: controller.signal,
        onEvent: (event) => {
          // 已取消的请求即使还有排队的缓冲事件也不应继续写入。
          if (controller.signal.aborted) return;
          dispatch({ type: 'event', event });
        },
      });
    } catch (error) {
      if (controllerRef.current !== controller) return;
      if (controller.signal.aborted) {
        dispatch({ type: 'cancel' });
        return;
      }
      const message = error instanceof Error ? error.message : String(error || '翻译失败');
      dispatch({
        type: 'fail',
        message,
        status: Number((error as { status?: number })?.status) || 0,
        code: String((error as { code?: string })?.code || ''),
      });
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }, []);

  const cancel = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    dispatch({ type: 'cancel' });
  }, []);

  const reset = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    dispatch({ type: 'reset' });
  }, []);

  return { state, busy: state.status === 'streaming', run, cancel, reset };
}
