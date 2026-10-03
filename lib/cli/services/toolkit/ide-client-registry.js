'use strict';

// IDE 宿主描述来自各自的应用插件（lib/server/app-installers/<id>.js 的 host 段），
// 同一个文件同时声明宿主（可执行文件、安装位置、配置目录）与安装方式；
// 这里只做聚合与按平台的路径推导，不再维护第二份 IDE 名单。
let ideClientsCache = null;

function loadIdeClients() {
  if (ideClientsCache) return ideClientsCache;
  // 延迟加载：安装器注册表会间接依赖 toolkit 服务，顶层 require 会形成初始化环。
  const { INSTALLERS } = require('../../../server/app-installers');
  const clients = Object.values(INSTALLERS)
    .map((installer) => installer && installer.ideClient)
    .filter(Boolean)
    .sort((left, right) => (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER));
  ideClientsCache = Object.freeze(Object.fromEntries(clients.map((client) => [client.id, client])));
  return ideClientsCache;
}

function normalizeClientId(value) {
  return String(value || '').trim().toLowerCase();
}

function listIdeClients() {
  return Object.keys(loadIdeClients());
}

function getIdeClient(clientId) {
  return loadIdeClients()[normalizeClientId(clientId)] || null;
}

function uniqueValues(values) {
  return Array.from(new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean)));
}

function clientValues(client, pluralKey, singularKey) {
  const plural = Array.isArray(client && client[pluralKey]) ? client[pluralKey] : [];
  return uniqueValues([...plural, client && client[singularKey]]);
}

function resolveIdeExtensionRoots(clientId, options = {}) {
  const client = getIdeClient(clientId);
  const home = String(options.hostHomeDir || '').trim();
  const platform = String(options.platform || '').trim().toLowerCase();
  const pathImpl = options.pathImpl;
  const env = options.env || {};
  if (!client || !home || !pathImpl || typeof pathImpl.join !== 'function') return [];

  const roots = [pathImpl.join(home, `.${client.id}`, 'extensions')];
  if (client.remoteServerDirectoryName) roots.push(pathImpl.join(home, client.remoteServerDirectoryName, 'extensions'));

  const appData = String(env.APPDATA || '').trim();
  if (platform === 'windows' && appData) {
    roots.push(pathImpl.join(appData, client.configDirectoryName, 'User', 'extensions'));
  }
  if (platform === 'macos') {
    roots.push(pathImpl.join(home, 'Library', 'Application Support', client.configDirectoryName, 'User', 'extensions'));
  }
  return uniqueValues(roots);
}

function getIdeConfigPath(clientId, options = {}) {
  const client = getIdeClient(clientId);
  const home = String(options.homeDir || options.hostHomeDir || '').trim();
  const platform = String(options.platform || '').trim().toLowerCase();
  const pathImpl = options.pathImpl;
  const env = options.env || {};
  if (!client || !home || !pathImpl || typeof pathImpl.join !== 'function') return '';

  const appData = String(env.APPDATA || pathImpl.join(home, 'AppData', 'Roaming')).trim();
  const configHome = String(env.XDG_CONFIG_HOME || pathImpl.join(home, '.config')).trim();
  if (platform === 'macos') {
    return pathImpl.join(home, 'Library', 'Application Support', client.configDirectoryName, 'User', 'settings.json');
  }
  if (platform === 'windows') {
    return pathImpl.join(appData, client.configDirectoryName, 'User', 'settings.json');
  }
  return pathImpl.join(configHome, client.configDirectoryName, 'User', 'settings.json');
}

function resolveIdeInstallCandidates(client, options = {}) {
  const home = String(options.hostHomeDir || '').trim();
  const platform = String(options.platform || '').trim().toLowerCase();
  const pathImpl = options.pathImpl;
  const env = options.env || {};
  if (!client || !home || !pathImpl || typeof pathImpl.join !== 'function') return [];

  if (platform === 'macos') {
    return uniqueValues(clientValues(client, 'macBundleNames', 'macBundleName').flatMap((bundleName) => [
      pathImpl.join('/Applications', bundleName),
      pathImpl.join(home, 'Applications', bundleName)
    ]));
  }
  if (platform === 'windows') {
    const localAppData = String(env.LOCALAPPDATA || pathImpl.join(home, 'AppData', 'Local')).trim();
    const programFiles = String(env.ProgramFiles || '').trim();
    const programNames = clientValues(client, 'windowsProgramNames', 'windowsProgramName');
    const executableNames = clientValues(client, 'windowsExecutableNames', 'windowsExecutableName');
    const roots = uniqueValues([
      pathImpl.join(localAppData, 'Programs'),
      programFiles,
      pathImpl.join(home, 'AppData', 'Local', 'Programs')
    ]);
    return uniqueValues(roots.flatMap((root) => programNames.flatMap((programName) => (
      executableNames.map((executableName) => pathImpl.join(root, programName, executableName))
    ))));
  }
  return uniqueValues(clientValues(client, 'linuxExecutableNames', 'linuxExecutableName').flatMap((executableName) => [
    pathImpl.join('/usr/bin', executableName),
    pathImpl.join('/usr/local/bin', executableName),
    pathImpl.join(home, '.local', 'bin', executableName)
  ]));
}

function findIdeClientRecord(clientId, options = {}) {
  const client = getIdeClient(clientId);
  const fsImpl = options.fs;
  const platform = String(options.platform || '').trim().toLowerCase();
  const pathImpl = options.pathImpl;
  if (!client || !fsImpl || typeof fsImpl.existsSync !== 'function') return null;

  for (const candidate of resolveIdeInstallCandidates(client, options)) {
    if (!fsImpl.existsSync(candidate)) continue;
    if (platform === 'macos') {
      const executableNames = clientValues(client, 'macExecutableNames', 'macExecutableName');
      const executableName = executableNames.find((name) => fsImpl.existsSync(
        pathImpl.join(candidate, 'Contents', 'MacOS', name)
      )) || executableNames[0];
      return {
        bundlePath: candidate,
        executablePath: pathImpl.join(candidate, 'Contents', 'MacOS', executableName),
        displayPath: candidate,
        clientName: client.name
      };
    }
    return {
      bundlePath: '',
      executablePath: candidate,
      displayPath: candidate,
      clientName: client.name
    };
  }
  return null;
}

module.exports = {
  listIdeClients,
  getIdeClient,
  resolveIdeExtensionRoots,
  getIdeConfigPath,
  findIdeClientRecord
};
