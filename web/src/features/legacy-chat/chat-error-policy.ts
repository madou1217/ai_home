type ErrorPayload = {
  error?: unknown;
  message?: unknown;
  detail?: unknown;
};

const ERROR_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  no_available_account: '当前 server 上没有可用于该模型的账号：账号可能未在此 server 完成登录/凭据配置，或该模型不在账号的可用清单里。请在「账号」页补全该 server 的账号，或改用其他账号/模型。',
  account_not_configured: '所选账号在当前 server 上尚未完成配置（缺少登录凭据）。请先在「账号」页为该 server 补全登录后再发送。',
  invalid_claude_api_config: 'claude API Key 或 ANTHROPIC_BASE_URL 缺失，请在「账号」页补全配置。',
  missing_model: '请先选择一个模型再发送。',
  model_required: '请先选择一个模型再发送。',
  model_not_found: '该模型在当前 server 上不可用，请改用其他模型。',
  rate_limited: '该账号当前被上游限流/熔断，请稍后重试或改用其他账号。',
  cooldown: '该账号当前被上游限流/熔断，请稍后重试或改用其他账号。',
});

function asPayload(value: unknown): ErrorPayload {
  return value && typeof value === 'object' ? value as ErrorPayload : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function knownMessage(code: unknown): string {
  return ERROR_MESSAGES[text(code)] || '';
}

function parseMessage(raw: string): string {
  if (!raw.startsWith('{') && !raw.startsWith('[')) return '';
  try {
    const payload = asPayload(JSON.parse(raw));
    return knownMessage(payload.error) || text(payload.message) || text(payload.detail);
  } catch {
    return '';
  }
}

export function humanizeChatError(error: unknown, fallback: string): string {
  const errorRecord = asPayload(error);
  const response = asPayload((errorRecord as { response?: unknown }).response);
  const data = asPayload((response as { data?: unknown }).data);
  const backendMessage = text(data.message);
  if (backendMessage && backendMessage !== data.error) return backendMessage;

  const mapped = knownMessage(data.error);
  if (mapped) return mapped;

  const raw = text(errorRecord.message);
  if (!raw) return backendMessage || fallback;
  return knownMessage(raw) || parseMessage(raw) || backendMessage || raw;
}
