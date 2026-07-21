import { supportsExternalPending } from './provider-capabilities.js';

const PROVIDER_LABELS = Object.freeze({
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
  gemini: 'Gemini',
  agy: 'Antigravity'
});

function getProviderLabel(provider) {
  return PROVIDER_LABELS[String(provider || '').toLowerCase()] || '模型';
}

export function getThinkingStatusText(provider) {
  return provider === 'codex' ? 'Codex 正在思考...' : '正在思考...';
}

export function getProcessingStatusText() {
  return '正在处理...';
}

export function getGeneratingStatusText() {
  return '正在生成回复...';
}

export function formatRetryStatusText(event, provider = '', now = Date.now()) {
  const providerLabel = getProviderLabel(event?.provider || provider);
  if (event?.phase === 'recovered') return `${providerLabel} 连接已恢复，继续处理...`;

  const attempt = Number(event?.attempt);
  const maxAttempts = Number(event?.maxAttempts);
  const retryAfterMs = Number(event?.retryAfterMs);
  const retryAt = Number(event?.retryAt);
  const waitMs = Number.isFinite(retryAfterMs) && retryAfterMs >= 0
    ? retryAfterMs
    : (Number.isFinite(retryAt) && retryAt > now ? retryAt - now : 0);
  const waitText = waitMs > 0
    ? `${Math.ceil(waitMs / 1000)} 秒后`
    : '正在';
  const progress = Number.isFinite(attempt) && attempt > 0
    ? (Number.isFinite(maxAttempts) && maxAttempts > 0
        ? `（${Math.trunc(attempt)}/${Math.trunc(maxAttempts)}）`
        : `（第 ${Math.trunc(attempt)} 次）`)
    : '';
  const isTransport = event?.source === 'transport';
  const isRateLimited = Number(event?.status) === 429 || /rate.?limit/i.test(String(event?.reason || ''));
  const issue = isTransport ? '连接中断' : (isRateLimited ? '请求受限' : '请求暂时失败');
  const action = isTransport ? '重连' : '重试';
  return `${providerLabel} ${issue}，${waitText}${action}${progress}...`;
}

export function createRetryCountdown(event = {}, provider = '', startedAt = Date.now()) {
  const explicitRetryAt = Number(event?.retryAt);
  const retryAfterMs = Number(event?.retryAfterMs);
  const retryAt = Number.isFinite(explicitRetryAt) && explicitRetryAt > 0
    ? Math.max(startedAt, explicitRetryAt)
    : startedAt + (Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : 0);
  return {
    event: { ...event },
    provider: String(event?.provider || provider || '').toLowerCase(),
    startedAt,
    retryAt,
  };
}

export function formatRetryCountdownStatus(countdown, now = Date.now()) {
  if (!countdown) return '';
  return formatRetryStatusText({
    ...(countdown.event || {}),
    retryAt: undefined,
    retryAfterMs: Math.max(0, Number(countdown.retryAt) - now),
  }, countdown.provider, now);
}

export function getRetryCountdownDelayMs(countdown, now = Date.now()) {
  if (!countdown) return null;
  const remainingMs = Math.max(0, Number(countdown.retryAt) - now);
  if (remainingMs <= 0) return null;
  return remainingMs % 1000 || 1000;
}

export function formatStreamFailureText(failure, provider = '') {
  const message = String(failure?.message || '').trim();
  if (failure?.retryable !== true) return message;
  const providerLabel = getProviderLabel(provider);
  return `${providerLabel} 正在自动重试${message ? `：${message}` : '...'}`;
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
