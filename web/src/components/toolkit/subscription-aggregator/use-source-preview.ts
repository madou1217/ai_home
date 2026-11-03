import { useEffect, useState } from 'react';
import { aggregatorErrorText, LOCAL_SOURCE_MAX_BYTES, responseErrorCode, utf8ByteLength } from './aggregator-presentation';
import { subscriptionAggregatorAPI } from './subscription-aggregator-api';
import type { AggregatorSourcePreview } from './types';

const PREVIEW_DELAY_MS = 500;

export interface SourcePreviewState {
  preview: AggregatorSourcePreview | null;
  loading: boolean;
  error: string;
}

/** 拿一段本地内容向服务端要解析预览（不保存）。 */
export async function requestSourcePreview(content: string): Promise<SourcePreviewState> {
  if (utf8ByteLength(content) > LOCAL_SOURCE_MAX_BYTES) return { preview: null, loading: false, error: '内容超过 2 MB' };
  try {
    return { preview: await subscriptionAggregatorAPI.previewSource(content), loading: false, error: '' };
  } catch (previewError) {
    return { preview: null, loading: false, error: aggregatorErrorText(responseErrorCode(previewError), '解析预览失败') };
  }
}

/** 粘贴框的实时解析预览：停止输入半秒后再请求，旧请求的结果丢弃。 */
export function useSourcePreview(content: string, enabled: boolean) {
  const [state, setState] = useState<SourcePreviewState>({ preview: null, loading: false, error: '' });

  useEffect(() => {
    if (!enabled || !content.trim()) {
      setState({ preview: null, loading: false, error: '' });
      return undefined;
    }
    let cancelled = false;
    setState((current) => ({ ...current, loading: true }));
    const timer = window.setTimeout(() => {
      void requestSourcePreview(content).then((next) => {
        if (!cancelled) setState(next);
      });
    }, PREVIEW_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [content, enabled]);

  return state;
}
