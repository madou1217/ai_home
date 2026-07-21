'use strict';

function canonicalizeFabricProxyTargetPath(value) {
  const raw = String(value || '');
  const queryIndex = raw.indexOf('?');
  const rawPath = queryIndex === -1 ? raw : raw.slice(0, queryIndex);
  if (!rawPath.startsWith('/')
    || rawPath.startsWith('//')
    || rawPath.includes('\\')
    || /%(?:2f|5c)/i.test(rawPath)) return '';
  try {
    const base = 'http://fabric-loopback.invalid';
    const parsed = new URL(raw, base);
    if (parsed.origin !== base) return '';
    return `${parsed.pathname}${parsed.search}`;
  } catch (_error) {
    return '';
  }
}

module.exports = {
  canonicalizeFabricProxyTargetPath
};
