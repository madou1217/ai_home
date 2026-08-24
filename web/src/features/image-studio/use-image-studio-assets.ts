import { useEffect, useMemo, useRef, useState } from 'react';
import { imageStudioAPI } from '@/services/api';
import {
  imageStudioAssetKey,
  pruneImageStudioAssetUrls,
  shouldAutoRetryImageStudioAsset,
} from './image-studio-utils';

export interface ImageStudioAssetRequest {
  sessionId: string;
  assetId: string;
  mimeType: string;
}

export function useImageStudioAssetUrls(requests: ImageStudioAssetRequest[]) {
  const cacheRef = useRef(new Map<string, string>());
  const pendingRef = useRef(new Set<string>());
  const failedRef = useRef(new Set<string>());
  const attemptRef = useRef(new Map<string, number>());
  const retryTimerRef = useRef(new Map<string, number>());
  const activeKeysRef = useRef(new Set<string>());
  const mountedRef = useRef(false);
  const [version, setVersion] = useState(0);

  const normalizedRequests = useMemo(() => {
    const unique = new Map<string, ImageStudioAssetRequest>();
    requests.forEach((request) => {
      if (!request.sessionId || !request.assetId) return;
      unique.set(imageStudioAssetKey(request.sessionId, request.assetId), request);
    });
    return [...unique.values()];
  }, [requests]);
  const activeKeys = useMemo(
    () => new Set(normalizedRequests.map((request) => imageStudioAssetKey(request.sessionId, request.assetId))),
    [normalizedRequests],
  );

  useEffect(() => {
    mountedRef.current = true;
    const retryFailedAssets = () => {
      let retry = false;
      failedRef.current.forEach((key) => {
        if (!activeKeysRef.current.has(key) || pendingRef.current.has(key) || cacheRef.current.has(key)) return;
        const timer = retryTimerRef.current.get(key);
        if (timer != null) window.clearTimeout(timer);
        retryTimerRef.current.delete(key);
        failedRef.current.delete(key);
        attemptRef.current.delete(key);
        retry = true;
      });
      if (retry) setVersion((value) => value + 1);
    };
    window.addEventListener('focus', retryFailedAssets);
    return () => {
      mountedRef.current = false;
      window.removeEventListener('focus', retryFailedAssets);
      retryTimerRef.current.forEach((timer) => window.clearTimeout(timer));
      retryTimerRef.current.clear();
      cacheRef.current.forEach((url) => URL.revokeObjectURL(url));
      cacheRef.current.clear();
      pendingRef.current.clear();
      failedRef.current.clear();
      attemptRef.current.clear();
      activeKeysRef.current.clear();
    };
  }, []);

  useEffect(() => {
    activeKeysRef.current = activeKeys;
    const removed = pruneImageStudioAssetUrls(cacheRef.current, activeKeys, URL.revokeObjectURL);
    attemptRef.current.forEach((_attempt, key) => {
      if (activeKeys.has(key)) return;
      attemptRef.current.delete(key);
      failedRef.current.delete(key);
      const timer = retryTimerRef.current.get(key);
      if (timer != null) window.clearTimeout(timer);
      retryTimerRef.current.delete(key);
    });
    if (removed > 0) setVersion((value) => value + 1);
  }, [activeKeys]);

  useEffect(() => {
    normalizedRequests.forEach((request) => {
      const key = imageStudioAssetKey(request.sessionId, request.assetId);
      if (cacheRef.current.has(key) || pendingRef.current.has(key) || failedRef.current.has(key)) return;
      pendingRef.current.add(key);
      imageStudioAPI.getAssetBlob(request.sessionId, request.assetId, request.mimeType)
        .then((blob) => {
          const url = URL.createObjectURL(blob);
          if (!mountedRef.current || !activeKeysRef.current.has(key)) {
            URL.revokeObjectURL(url);
            return;
          }
          const previous = cacheRef.current.get(key);
          if (previous) URL.revokeObjectURL(previous);
          cacheRef.current.set(key, url);
          failedRef.current.delete(key);
          attemptRef.current.delete(key);
          setVersion((value) => value + 1);
        })
        .catch(() => {
          if (!mountedRef.current || !activeKeysRef.current.has(key)) return;
          const attempt = (attemptRef.current.get(key) || 0) + 1;
          attemptRef.current.set(key, attempt);
          failedRef.current.add(key);
          if (!shouldAutoRetryImageStudioAsset(attempt)) return;
          const timer = window.setTimeout(() => {
            retryTimerRef.current.delete(key);
            if (!mountedRef.current || !activeKeysRef.current.has(key)) return;
            failedRef.current.delete(key);
            setVersion((value) => value + 1);
          }, attempt * 500);
          retryTimerRef.current.set(key, timer);
        })
        .finally(() => {
          pendingRef.current.delete(key);
        });
    });
  }, [normalizedRequests, version]);

  return useMemo(() => {
    const urls: Record<string, string> = {};
    cacheRef.current.forEach((url, key) => {
      if (activeKeys.has(key)) urls[key] = url;
    });
    return urls;
  }, [activeKeys, version]);
}
