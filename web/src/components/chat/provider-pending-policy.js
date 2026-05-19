import { supportsExternalPending } from './provider-capabilities.js';

export function getThinkingStatusText(provider) {
  return provider === 'codex' ? 'Codex 正在思考...' : '正在思考...';
}

export function getProcessingStatusText() {
  return '正在处理...';
}

export function getGeneratingStatusText() {
  return '正在生成回复...';
}

export function shouldUseExternalPending(provider) {
  return supportsExternalPending(provider);
}

export function normalizePendingStatusText(rawText, provider) {
  const raw = String(rawText || '').trim();
  if (provider === 'codex') return '正在思考中';
  if (!raw) return '正在思考中';
  if (raw.includes('正在思考')) return '正在思考中';
  return raw.replace(/\.{3,}$/g, '').trim();
}
