'use strict';

const nodeFs = require('node:fs');
const {
  entryArguments,
  entryArgumentsForRole,
  entryDirectlyRunsRole,
  entryExecutableForRole,
  entryMatchesRole,
  fileExists,
  readProcessEntries,
  readStartupEntries,
  resolveCandidatePath,
  resolveEntryBase,
  resolveEnv,
  resolveHome,
  resolvePathApi,
  resolvePlatform,
  unique
} = require('./host-runtime-discovery');

const FRP_CONFIG_EXTENSIONS = Object.freeze(['toml', 'yaml', 'yml', 'json', 'ini']);
const FRP_CONFIG_FLAGS = Object.freeze(['-c', '--config', '--config-file']);
const FRP_CONFIG_DIR_FLAGS = Object.freeze(['--config-dir']);
const FRP_ROLES = Object.freeze(['frpc']);
const NETWORK_TOOL_IDS = Object.freeze(['frpc']);

const NETWORK_TOOL_SPECS = Object.freeze({
  frpc: Object.freeze({
    id: 'frpc',
    configFlags: FRP_CONFIG_FLAGS,
    configDirFlags: FRP_CONFIG_DIR_FLAGS,
    configExtensions: FRP_CONFIG_EXTENSIONS,
    environmentKeys: ['AIH_FRPC_CONFIG', 'FRPC_CONFIG'],
    defaultCwdNames: ['frpc.ini']
  }),
});

function normalizeFlag(value) {
  return String(value || '').trim().toLowerCase();
}

function extractFlagValues(entry, flags, role, options = {}) {
  const normalizedFlags = new Set((flags || []).map(normalizeFlag));
  const args = role
    ? entryArgumentsForRole(entry, role, resolvePathApi(options))
    : entryArguments(entry);
  const values = [];
  let present = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index] || '').trim();
    const lower = arg.toLowerCase();
    if (normalizedFlags.has(lower)) {
      present = true;
      if (args[index + 1]) values.push(args[index + 1]);
      continue;
    }
    for (const flag of normalizedFlags) {
      const prefix = `${flag}=`;
      if (!lower.startsWith(prefix)) continue;
      present = true;
      values.push(arg.slice(prefix.length));
      break;
    }
  }
  return { present, values };
}

function extractConfigPath(entry, options = {}) {
  const flags = options.configFlags || FRP_CONFIG_FLAGS;
  const match = extractFlagValues(entry, flags, options.role || 'frpc', options).values[0];
  return resolveCandidatePath(match || entry && entry.configPath, entry, options);
}

function listConfigDirectory(directory, spec, source, options = {}) {
  if (!directory) return [];
  const fsImpl = options.fs || nodeFs;
  const pathImpl = resolvePathApi(options);
  const extensions = new Set(spec.configExtensions.map((extension) => `.${extension}`));
  try {
    return fsImpl.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() || entry.isSymbolicLink())
      .map((entry) => pathImpl.join(directory, entry.name))
      .filter((targetPath) => extensions.has(pathImpl.extname(targetPath).toLowerCase()))
      .map((targetPath) => ({ path: targetPath, source }));
  } catch (_error) {
    return [];
  }
}

function collectEntryCandidates(spec, entry, source, options = {}) {
  const candidates = [];
  const configMatches = extractFlagValues(entry, spec.configFlags, spec.id, options);
  const directoryMatches = extractFlagValues(entry, spec.configDirFlags, spec.id, options);

  for (const value of configMatches.values) {
    const targetPath = resolveCandidatePath(value, entry, options);
    if (targetPath) candidates.push({ path: targetPath, source });
  }
  for (const value of directoryMatches.values) {
    const directory = resolveCandidatePath(value, entry, options);
    candidates.push(...listConfigDirectory(directory, spec, source, options));
  }

  if (configMatches.present || directoryMatches.present) return candidates;
  const base = resolveEntryBase(entry, options);
  const pathImpl = resolvePathApi(options);
  for (const name of spec.defaultCwdNames) {
    if (base) candidates.push({ path: pathImpl.join(base, name), source: 'working-directory' });
  }
  return candidates;
}

function addFrpDirectory(candidates, role, directory, pathImpl) {
  if (!directory) return;
  for (const extension of FRP_CONFIG_EXTENSIONS) {
    candidates.push(pathImpl.join(directory, `${role}.${extension}`));
  }
}

function standardConfigCandidates(spec, options = {}) {
  const platform = resolvePlatform(options);
  const env = resolveEnv(options);
  const home = resolveHome(options);
  const pathImpl = resolvePathApi(options);
  const candidates = [];

  if (platform === 'win32') {
    const programData = env.PROGRAMDATA || env.ProgramData || env.programdata || '';
    const appData = env.APPDATA || env.AppData || env.appdata
      || (home ? pathImpl.join(home, 'AppData', 'Roaming') : '');
    addFrpDirectory(candidates, spec.id, programData && pathImpl.join(programData, 'frp'), pathImpl);
    addFrpDirectory(candidates, spec.id, appData && pathImpl.join(appData, 'frp'), pathImpl);
    addFrpDirectory(candidates, spec.id, home && pathImpl.join(home, '.config', 'frp'), pathImpl);
  } else {
    addFrpDirectory(candidates, spec.id, home && pathImpl.join(home, '.config', 'frp'), pathImpl);
    addFrpDirectory(candidates, spec.id, '/etc/frp', pathImpl);
    addFrpDirectory(candidates, spec.id, '/usr/local/etc/frp', pathImpl);
    addFrpDirectory(candidates, spec.id, '/etc', pathImpl);
    if (platform === 'darwin') addFrpDirectory(candidates, spec.id, '/opt/homebrew/etc/frp', pathImpl);
  }
  return unique(candidates);
}

function environmentConfigCandidates(spec, options = {}) {
  const env = resolveEnv(options);
  const pathImpl = resolvePathApi(options);
  for (const key of spec.environmentKeys) {
    const value = String(env[key] || '').trim();
    if (!value) continue;
    const targetPath = resolveCandidatePath(value, {}, options);
    if (targetPath && pathImpl.isAbsolute(targetPath)) return [{ path: targetPath, source: 'environment' }];
  }
  return [];
}

function isEditableConfig(spec, targetPath, options = {}) {
  if (!targetPath) return false;
  const pathImpl = resolvePathApi(options);
  const extension = pathImpl.extname(targetPath).replace(/^\./, '').toLowerCase();
  if (!spec.configExtensions.includes(extension)) return false;
  return true;
}

function candidateKey(targetPath, options = {}) {
  const pathImpl = resolvePathApi(options);
  const normalized = pathImpl.normalize(String(targetPath || ''));
  return resolvePlatform(options) === 'win32' ? normalized.toLowerCase() : normalized;
}

function selectExistingCandidates(spec, candidates, options = {}, firstOnly = false) {
  const fsImpl = options.fs || nodeFs;
  const selected = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const targetPath = String(candidate && candidate.path || '').trim();
    const key = candidateKey(targetPath, options);
    if (!targetPath || seen.has(key) || !isEditableConfig(spec, targetPath, options)) continue;
    seen.add(key);
    if (!fileExists(fsImpl, targetPath)) continue;
    selected.push({ path: targetPath, source: candidate.source });
    if (firstOnly) break;
  }
  return selected;
}

function entryDeclaresConfig(spec, entry, options = {}) {
  return extractFlagValues(entry, spec.configFlags, spec.id, options).present
    || extractFlagValues(entry, spec.configDirFlags, spec.id, options).present;
}

function selectedConfigResult(selected) {
  if (selected.length > 1) {
    return { path: '', source: '', count: selected.length, ambiguous: true, state: 'multiple' };
  }
  if (selected.length === 1) {
    return {
      path: selected[0].path,
      source: selected[0].source,
      count: 1,
      ambiguous: false,
      state: 'single'
    };
  }
  return null;
}

function selectEntryTier(spec, entries, sourceForEntry, options = {}) {
  const candidatesByEntry = entries.map((entry) => ({
    entry,
    candidates: collectEntryCandidates(spec, entry, sourceForEntry(entry), options)
  }));
  const selected = selectExistingCandidates(
    spec,
    candidatesByEntry.flatMap((item) => item.candidates),
    options,
    false
  );
  const result = selectedConfigResult(selected);
  const authoritative = entries.length > 0;
  const unresolved = authoritative && candidatesByEntry.some((item) => (
    item.candidates.length === 0
    || selectExistingCandidates(spec, item.candidates, options, false).length === 0
  ));
  if (unresolved) {
    return { path: '', source: '', count: selected.length, ambiguous: true, state: 'unresolved' };
  }
  return result;
}

function selectConfig(spec, matchingProcesses, matchingStartup, options = {}) {
  const processResult = selectEntryTier(spec, matchingProcesses, () => 'running-process', options);
  if (processResult) return processResult;
  const startupResult = selectEntryTier(
    spec,
    matchingStartup,
    (entry) => entry.source || 'startup-task',
    options
  );
  if (startupResult) return startupResult;

  const environmentDeclared = spec.environmentKeys.some((key) => String(resolveEnv(options)[key] || '').trim());
  const environmentSelected = selectExistingCandidates(spec, environmentConfigCandidates(spec, options), options, true);
  const environmentResult = selectedConfigResult(environmentSelected);
  if (environmentResult) return environmentResult;
  if (environmentDeclared) {
    return { path: '', source: '', count: 0, ambiguous: true, state: 'unresolved' };
  }

  const standardSelected = selectExistingCandidates(
    spec,
    standardConfigCandidates(spec, options).map((targetPath) => ({ path: targetPath, source: 'standard-path' })),
    options,
    true
  );
  return selectedConfigResult(standardSelected)
    || { path: '', source: '', count: 0, ambiguous: false, state: 'none' };
}

function discoverNetworkTools(options = {}) {
  const fsImpl = options.fs || nodeFs;
  const pathImpl = resolvePathApi(options);
  const snapshotOptions = { ...options, managedRoles: NETWORK_TOOL_IDS };
  const processes = readProcessEntries(snapshotOptions);
  const startupEntries = readStartupEntries(snapshotOptions);
  const result = {};

  for (const toolId of NETWORK_TOOL_IDS) {
    const spec = NETWORK_TOOL_SPECS[toolId];
    const allMatchingProcesses = processes.filter((entry) => entryMatchesRole(entry, toolId, pathImpl));
    const directProcesses = allMatchingProcesses.filter((entry) => entryDirectlyRunsRole(entry, toolId, pathImpl));
    const matchingProcesses = directProcesses.length > 0 ? directProcesses : allMatchingProcesses;
    const matchingStartup = startupEntries.filter((entry) => entryMatchesRole(entry, toolId, pathImpl));
    const config = selectConfig(spec, matchingProcesses, matchingStartup, options);
    const executablePath = String(
      matchingProcesses.map((entry) => entryExecutableForRole(entry, toolId, pathImpl)).find(Boolean)
      || matchingStartup.map((entry) => entryExecutableForRole(entry, toolId, pathImpl)).find(Boolean)
      || ''
    ).trim();
    const executableExists = matchingProcesses.length > 0
      || fileExists(fsImpl, executablePath)
      || matchingStartup.some((entry) => fileExists(fsImpl, entryExecutableForRole(entry, toolId, pathImpl)));
    const startupManaged = matchingStartup.some((entry) => entry.enabled !== false);
    result[toolId] = {
      running: matchingProcesses.length > 0,
      runningCount: matchingProcesses.length,
      startupManaged,
      startupSources: unique(matchingStartup
        .filter((entry) => entry.enabled !== false)
        .map((entry) => entry.source || 'startup-task')),
      executablePath,
      executableExists,
      configPath: config.path,
      configSource: config.source,
      configCount: config.count,
      configAmbiguous: config.ambiguous,
      configState: config.state
    };
  }
  return result;
}

function resolveNetworkToolConfigPath(toolId, options = {}) {
  const normalized = String(toolId || '').trim().toLowerCase();
  if (!NETWORK_TOOL_IDS.includes(normalized)) return '';
  return discoverNetworkTools(options)[normalized].configPath;
}

module.exports = {
  FRP_CONFIG_EXTENSIONS,
  FRP_ROLES,
  NETWORK_TOOL_IDS,
  NETWORK_TOOL_SPECS,
  discoverNetworkTools,
  extractConfigPath,
  resolveNetworkToolConfigPath,
  standardConfigCandidates
};
