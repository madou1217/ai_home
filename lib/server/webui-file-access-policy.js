'use strict';

const path = require('node:path');
const { getProviderStoragePolicy } = require('../runtime/provider-storage-policy');

// Provider storage roots also contain credentials and executable configuration.
// The WebUI file API only needs provider-owned conversation artifacts, so keep
// its allowlist independent from projection/storage mappings.
const PROVIDER_RESOURCE_SUBDIRS = Object.freeze({
  codex: Object.freeze([
    Object.freeze(['attachments'])
  ]),
  claude: Object.freeze([
    Object.freeze(['artifacts']),
    Object.freeze(['image-cache']),
    Object.freeze(['projects'])
  ]),
  gemini: Object.freeze([
    Object.freeze(['history']),
    Object.freeze(['tmp'])
  ]),
  agy: Object.freeze([
    Object.freeze(['brain']),
    Object.freeze(['scratch'])
  ]),
  opencode: Object.freeze([
    Object.freeze(['storage'])
  ])
});

const PROVIDER_CONFIGURATION_LOCATIONS = Object.freeze([
  Object.freeze({ path: Object.freeze(['.config', 'opencode']), recursive: true }),
  Object.freeze({ path: Object.freeze(['.gemini', 'config']), recursive: true }),
  Object.freeze({ path: Object.freeze(['.codex', 'config.toml']), variants: true }),
  Object.freeze({ path: Object.freeze(['.codex', 'hooks.json']), variants: true }),
  Object.freeze({ path: Object.freeze(['.claude', 'settings.json']), variants: true }),
  Object.freeze({ path: Object.freeze(['.claude', 'settings.local.json']), variants: true }),
  Object.freeze({ path: Object.freeze(['.claude', 'remote-settings.json']), variants: true }),
  Object.freeze({ path: Object.freeze(['.claude', '.mcp.json']), variants: true }),
  Object.freeze({ path: Object.freeze(['.claude', '.claude.json']), variants: true }),
  Object.freeze({ path: Object.freeze(['.mcp.json']), variants: true }),
  Object.freeze({ path: Object.freeze(['.claude.json']), variants: true }),
  Object.freeze({ path: Object.freeze(['.gemini', 'settings.json']), variants: true }),
  Object.freeze({ path: Object.freeze(['.gemini', '.gemini', 'settings.json']), variants: true }),
  Object.freeze({ path: Object.freeze(['.gemini', 'antigravity-cli', 'settings.json']), variants: true }),
  Object.freeze({ path: Object.freeze(['.gemini', 'antigravity-cli', 'settings.local.json']), variants: true }),
  Object.freeze({ path: Object.freeze(['.gemini', 'antigravity-cli', 'keybindings.json']), variants: true }),
  Object.freeze({ path: Object.freeze(['.gemini', 'antigravity-cli', 'mcp_config.json']), variants: true })
]);

function isPathWithinRoot(rootPath, targetPath, pathImpl) {
  const relative = pathImpl.relative(rootPath, targetPath);
  return relative === '' || Boolean(
    relative
    && relative !== '..'
    && !relative.startsWith(`..${pathImpl.sep}`)
    && !pathImpl.isAbsolute(relative)
  );
}

function isUnsafeTrustRoot(rootPath, options = {}, pathImpl = path) {
  const candidate = String(rootPath || '').trim();
  if (!candidate || !pathImpl.isAbsolute(candidate)) return true;
  const resolvedCandidate = pathImpl.resolve(candidate);
  if (resolvedCandidate === pathImpl.parse(resolvedCandidate).root) return true;

  const protectedRoots = [options.hostHomeDir, options.aiHomeDir]
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .map((item) => pathImpl.resolve(item));
  return protectedRoots.some((protectedRoot) => (
    isPathWithinRoot(resolvedCandidate, protectedRoot, pathImpl)
  ));
}

function createFileTrustCandidates(filePath, options = {}, pathImpl = path) {
  const target = String(filePath || '').trim();
  if (!target || !pathImpl.isAbsolute(target)) return [];
  const fileDirectory = pathImpl.dirname(pathImpl.resolve(target));
  const candidates = [
    {
      scope: 'file_directory',
      path: fileDirectory,
      label: '信任此文件夹',
      description: '仅允许预览此文件夹及其子目录中的文件'
    },
    {
      scope: 'parent_directory',
      path: pathImpl.dirname(fileDirectory),
      label: '信任父级文件夹',
      description: '允许预览父级文件夹及其所有子目录中的文件'
    }
  ];

  const seen = new Set();
  return candidates.filter((candidate) => {
    if (seen.has(candidate.path) || isUnsafeTrustRoot(candidate.path, options, pathImpl)) return false;
    seen.add(candidate.path);
    return true;
  });
}

function isProviderConfigurationPath(hostHomeDir, targetPath, pathImpl = path) {
  const home = String(hostHomeDir || '').trim();
  const target = String(targetPath || '').trim();
  if (!home || !target || !pathImpl.isAbsolute(target)) return false;
  const resolvedTarget = pathImpl.resolve(target);

  return PROVIDER_CONFIGURATION_LOCATIONS.some((location) => {
    const resolvedLocation = pathImpl.resolve(home, ...location.path);
    if (location.recursive) {
      return isPathWithinRoot(resolvedLocation, resolvedTarget, pathImpl);
    }
    if (!location.variants) {
      return pathImpl.relative(resolvedLocation, resolvedTarget) === '';
    }
    // AIH/provider migrations preserve configuration as `<name>.<suffix>`;
    // backups must retain the same deny semantics as the active file.
    if (pathImpl.relative(pathImpl.dirname(resolvedLocation), pathImpl.dirname(resolvedTarget)) !== '') {
      return false;
    }
    const caseInsensitive = pathImpl.sep === '\\';
    const expectedName = pathImpl.basename(resolvedLocation);
    const actualName = pathImpl.basename(resolvedTarget);
    const comparableExpected = caseInsensitive ? expectedName.toLowerCase() : expectedName;
    const comparableActual = caseInsensitive ? actualName.toLowerCase() : actualName;
    return comparableActual === comparableExpected
      || comparableActual.startsWith(`${comparableExpected}.`);
  });
}

function resolveProviderReadableResourceRoots(hostHomeDir, pathImpl = path) {
  const home = String(hostHomeDir || '').trim();
  if (!home) return [];

  const roots = [];
  Object.entries(PROVIDER_RESOURCE_SUBDIRS).forEach(([provider, resourceSubdirs]) => {
    const policy = getProviderStoragePolicy(provider);
    if (!policy) return;
    const nativeRoot = pathImpl.resolve(home, ...policy.nativeRoot);
    [policy.attachmentSubdir, ...resourceSubdirs].forEach((subdir) => {
      roots.push(pathImpl.resolve(nativeRoot, ...subdir));
    });
  });

  return Array.from(new Set(roots));
}

module.exports = {
  createFileTrustCandidates,
  isPathWithinRoot,
  isProviderConfigurationPath,
  isUnsafeTrustRoot,
  resolveProviderReadableResourceRoots
};
