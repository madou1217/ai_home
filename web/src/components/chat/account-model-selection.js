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
