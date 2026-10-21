// 当前会话的捕获身份：聊天消息内的 HTML 预览在截图/录制时用它解析水印。
// 由消息渲染层提供，HtmlCodeBlock 消费；捕获瞬间读取，避免使用全局设置。

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { CaptureWatermarkIdentity } from './watermark';

const CaptureIdentityContext = createContext<CaptureWatermarkIdentity | null>(null);

export function CaptureIdentityProvider({
  value,
  children
}: {
  value: CaptureWatermarkIdentity | null;
  children: ReactNode;
}) {
  return <CaptureIdentityContext.Provider value={value}>{children}</CaptureIdentityContext.Provider>;
}

/** 按 provider/model 稳定 context value，避免父级普通重渲染唤醒所有预览消费者。 */
export function CaptureIdentityBoundary({
  provider,
  model,
  children
}: {
  provider: string;
  model: string;
  children: ReactNode;
}) {
  const value = useMemo<CaptureWatermarkIdentity>(() => ({ provider, model }), [provider, model]);
  return <CaptureIdentityProvider value={value}>{children}</CaptureIdentityProvider>;
}

export function useCaptureIdentity(): CaptureWatermarkIdentity | null {
  return useContext(CaptureIdentityContext);
}
