'use strict';

const nodePath = require('node:path');
const {
  PROVIDER_STORAGE_POLICIES,
  getProviderProjectionMappings,
  getProviderPrivateArtifacts,
  getProviderStoragePolicy,
  normalizeProvider
} = require('./provider-storage-policy');

// These are transcript aliases, not storage roots. The legacy prefix is kept
// only so historical messages can be translated to provider-native paths;
// production code must never read or write provider state through it.
const ACCOUNT_PROJECTION_ALIAS_PREFIXES = Object.freeze([
  Object.freeze(['run', 'auth-projections']),
  Object.freeze(['profiles'])
]);

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeSegment(value, caseInsensitive) {
  const text = String(value || '');
  return caseInsensitive ? text.toLowerCase() : text;
}

function segmentsStartWith(segments, prefix, caseInsensitive) {
  if (prefix.length > segments.length) return false;
  return prefix.every((segment, index) => (
    normalizeSegment(segments[index], caseInsensitive) === normalizeSegment(segment, caseInsensitive)
  ));
}

function isOutsideRoot(relativePath, pathImpl) {
  return !relativePath
    || relativePath === '..'
    || relativePath.startsWith(`..${pathImpl.sep}`)
    || pathImpl.isAbsolute(relativePath);
}

function resolveAccountProjectionAliasSegments(filePath, aiHomeDir, pathImpl, caseInsensitive) {
  const relativePath = pathImpl.relative(pathImpl.resolve(aiHomeDir), pathImpl.resolve(filePath));
  if (isOutsideRoot(relativePath, pathImpl)) return null;
  const segments = relativePath.split(pathImpl.sep).filter(Boolean);

  for (const prefix of ACCOUNT_PROJECTION_ALIAS_PREFIXES) {
    if (segmentsStartWith(segments, prefix, caseInsensitive)) {
      return segments.slice(prefix.length);
    }
  }
  return null;
}

function isPrivateArtifactTail(policy, provider, tailSegments, caseInsensitive) {
  return [...policy.authArtifacts, ...getProviderPrivateArtifacts(provider)].some((artifact) => {
    const artifactPath = artifact.path;
    if (artifactPath.length > tailSegments.length) return false;
    const parent = artifactPath.slice(0, -1);
    if (!segmentsStartWith(tailSegments, parent, caseInsensitive)) return false;
    const actualName = normalizeSegment(tailSegments[parent.length], caseInsensitive);
    const artifactName = normalizeSegment(artifactPath[artifactPath.length - 1], caseInsensitive);
    return actualName === artifactName || actualName.startsWith(`${artifactName}.`);
  });
}

function resolveProviderResourcePath(filePath, options = {}) {
  const pathImpl = options.path || nodePath;
  const requestedPath = String(filePath || '').trim();
  const aiHomeDir = String(options.aiHomeDir || '').trim();
  const hostHomeDir = String(options.hostHomeDir || '').trim();
  const expectedProvider = normalizeProvider(options.provider);
  const caseInsensitive = options.caseInsensitive === true || pathImpl === nodePath.win32;

  if (!requestedPath || !aiHomeDir || !hostHomeDir || !pathImpl.isAbsolute(requestedPath)) {
    return { path: requestedPath, provider: '', canonicalized: false, blocked: false };
  }

  const segments = resolveAccountProjectionAliasSegments(
    requestedPath,
    aiHomeDir,
    pathImpl,
    caseInsensitive
  );
  if (!segments || segments.length < 3) {
    return { path: requestedPath, provider: '', canonicalized: false, blocked: false };
  }

  const provider = normalizeProvider(segments[0]);
  if (!provider || (expectedProvider && provider !== expectedProvider)) {
    return { path: requestedPath, provider: '', canonicalized: false, blocked: false };
  }
  const policy = getProviderStoragePolicy(provider);
  const tailSegments = segments.slice(2);
  if (isPrivateArtifactTail(policy, provider, tailSegments, caseInsensitive)) {
    return { path: requestedPath, provider, canonicalized: false, blocked: true };
  }

  for (const mapping of getProviderProjectionMappings(provider)) {
    if (!segmentsStartWith(tailSegments, mapping.from, caseInsensitive)) continue;
    const remainder = tailSegments.slice(mapping.from.length);
    return {
      path: pathImpl.join(hostHomeDir, ...mapping.to, ...remainder),
      provider,
      canonicalized: true,
      blocked: false
    };
  }

  return { path: requestedPath, provider: '', canonicalized: false, blocked: false };
}

function canonicalizeProviderResourcePath(filePath, options = {}) {
  return resolveProviderResourcePath(filePath, options).path;
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function separatorAgnosticPathPattern(value) {
  return String(value || '')
    .replace(/\\/g, '/')
    .split('/')
    .map(escapeRegExp)
    .join('[\\\\/]');
}

function buildProjectionAliasTextPatterns(aiHomeDir, pathImpl) {
  const aiHomePattern = separatorAgnosticPathPattern(pathImpl.resolve(aiHomeDir));
  return ACCOUNT_PROJECTION_ALIAS_PREFIXES.map((prefix) => (
    [aiHomePattern, ...prefix.map(escapeRegExp)].join('[\\\\/]')
  ));
}

function sensitiveSuffixesForMapping(policy, provider, mapping, caseInsensitive) {
  return [...policy.authArtifacts, ...getProviderPrivateArtifacts(provider)]
    .filter((artifact) => segmentsStartWith(artifact.path, mapping.from, caseInsensitive))
    .map((artifact) => artifact.path.slice(mapping.from.length).join('/'))
    .filter(Boolean);
}

function followsSensitiveSuffix(source, offset, suffixes, caseInsensitive) {
  const tail = String(source || '').slice(offset).replace(/\\/g, '/').replace(/^\/+/, '');
  const comparableTail = caseInsensitive ? tail.toLowerCase() : tail;
  return suffixes.some((suffix) => {
    const comparableSuffix = caseInsensitive ? suffix.toLowerCase() : suffix;
    if (!comparableTail.startsWith(comparableSuffix)) return false;
    const nextCharacter = comparableTail.charAt(comparableSuffix.length);
    return !nextCharacter
      || nextCharacter === '/'
      || nextCharacter === '.'
      || /[\s"'<>()[\]{},;:!?#]/.test(nextCharacter);
  });
}

function canonicalizeProviderResourceText(value, options = {}) {
  let text = String(value || '');
  if (!text) return text;

  const pathImpl = options.path || nodePath;
  const aiHomeDir = String(options.aiHomeDir || '').trim();
  const hostHomeDir = String(options.hostHomeDir || '').trim();
  const expectedProvider = normalizeProvider(options.provider);
  const caseInsensitive = options.caseInsensitive === true || pathImpl === nodePath.win32;
  if (!aiHomeDir || !hostHomeDir) return text;

  const projectionRootPatterns = buildProjectionAliasTextPatterns(aiHomeDir, pathImpl);
  const providers = expectedProvider ? [expectedProvider] : Object.keys(PROVIDER_STORAGE_POLICIES);

  for (const projectionRootPattern of projectionRootPatterns) {
    for (const provider of providers) {
      const policy = getProviderStoragePolicy(provider);
      for (const mapping of getProviderProjectionMappings(provider)) {
        const sourcePattern = [
          projectionRootPattern,
          escapeRegExp(provider),
          '[^\\\\/\\s"\'<>]+',
          ...mapping.from.map(escapeRegExp)
        ].join('[\\\\/]');
        const regex = new RegExp(`${sourcePattern}(?=$|[\\\\/\\s"\'<>])`, caseInsensitive ? 'gi' : 'g');
        const replacement = pathImpl.join(hostHomeDir, ...mapping.to);
        const sensitiveSuffixes = sensitiveSuffixesForMapping(policy, provider, mapping, caseInsensitive);
        text = text.replace(regex, (match, offset, source) => (
          followsSensitiveSuffix(source, Number(offset) + match.length, sensitiveSuffixes, caseInsensitive)
            ? match
            : replacement
        ));
      }
    }
  }

  return text;
}

function canonicalizeProviderResourceValue(value, options = {}, seen = new WeakMap()) {
  if (typeof value === 'string') return canonicalizeProviderResourceText(value, options);
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);

  if (Array.isArray(value)) {
    const result = [];
    seen.set(value, result);
    value.forEach((item) => result.push(canonicalizeProviderResourceValue(item, options, seen)));
    return result;
  }

  if (!isPlainObject(value)) return value;
  const result = {};
  seen.set(value, result);
  Object.entries(value).forEach(([key, item]) => {
    result[key] = canonicalizeProviderResourceValue(item, options, seen);
  });
  return result;
}

module.exports = {
  canonicalizeProviderResourcePath,
  canonicalizeProviderResourceText,
  canonicalizeProviderResourceValue,
  resolveProviderResourcePath
};
