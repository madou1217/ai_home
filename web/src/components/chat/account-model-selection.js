function normalizeModelIds(values) {
  if (!Array.isArray(values)) return [];
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const id = String(value || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function listAccountEnabledModels(catalog, accountRef) {
  const ref = String(accountRef || '').trim();
  if (!ref) return [];

  const byAccountRef = catalog && typeof catalog.selectableByAccountRef === 'object'
    ? catalog.selectableByAccountRef
    : catalog && typeof catalog.byAccountRef === 'object'
      ? catalog.byAccountRef
      : {};
  return normalizeModelIds(byAccountRef[ref]);
}

// 会话级"上次使用模型"记忆：按 provider:id:projectDirName 建 key；draft/无 id 返回空（不读不写）。
export function getSessionModelKey(session) {
  if (!session || session.draft) return '';
  const id = String(session.id || '').trim();
  if (!id) return '';
  const provider = String(session.provider || '').trim();
  const dir = String(session.projectDirName || '').trim();
  return `chat-session-model:${provider}:${id}:${dir}`;
}

export function readSessionModel(session) {
  const key = getSessionModelKey(session);
  if (!key || typeof window === 'undefined') return '';
  try {
    return window.localStorage.getItem(key) || '';
  } catch {
    return '';
  }
}

export function writeSessionModel(session, model) {
  const key = getSessionModelKey(session);
  const value = String(model || '').trim();
  if (!key || !value || typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, value);
  } catch {}
}

export function getAccountDefaultModel(catalog, accountRef) {
  const ref = String(accountRef || '').trim();
  if (!ref) return '';
  const defaultByAccountRef = catalog && typeof catalog.defaultByAccountRef === 'object'
    ? catalog.defaultByAccountRef
    : {};
  const modelId = String(defaultByAccountRef[ref] || '').trim();
  if (!modelId) return '';
  return listAccountEnabledModels(catalog, ref).includes(modelId) ? modelId : '';
}
