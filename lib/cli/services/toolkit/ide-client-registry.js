'use strict';

// IDE 宿主的路径、配置和扩展目录集中在一个注册表中。
// Provider 识别仍然来自 provider contract；这里仅描述宿主本身，避免
// app-manager 同时维护分类数组、路径 switch 和探测 switch 三份事实。

const IDE_CLIENTS = Object.freeze({
  vscode: Object.freeze({
    id: 'vscode',
    name: 'Visual Studio Code',
    binaryName: 'code',
    macBundleName: 'Visual Studio Code.app',
    macExecutableNames: Object.freeze(['Visual Studio Code', 'Electron']),
    windowsProgramName: 'Microsoft VS Code',
    windowsExecutableName: 'Code.exe',
    linuxExecutableName: 'code',
    configDirectoryName: 'Code'
  }),
  cursor: Object.freeze({
    id: 'cursor',
    name: 'Cursor',
    binaryName: 'cursor',
    macBundleName: 'Cursor.app',
    macExecutableNames: Object.freeze(['Cursor']),
    windowsProgramName: 'Cursor',
    windowsExecutableName: 'Cursor.exe',
    linuxExecutableName: 'cursor',
    configDirectoryName: 'Cursor'
  }),
  windsurf: Object.freeze({
    id: 'windsurf',
    name: 'Devin Desktop',
    binaryName: 'devin-desktop',
    macBundleName: 'Devin.app',
    macBundleNames: Object.freeze(['Devin.app', 'Windsurf.app']),
    macExecutableNames: Object.freeze(['Devin', 'Windsurf']),
    windowsProgramName: 'Windsurf',
    windowsProgramNames: Object.freeze(['Windsurf', 'Devin']),
    windowsExecutableName: 'Devin.exe',
    windowsExecutableNames: Object.freeze(['Devin.exe', 'Windsurf.exe']),
    linuxExecutableName: 'devin-desktop',
    linuxExecutableNames: Object.freeze(['devin-desktop', 'windsurf']),
    configDirectoryName: 'Windsurf'
  })
});

function normalizeClientId(value) {
  return String(value || '').trim().toLowerCase();
}

function listIdeClients() {
  return Object.keys(IDE_CLIENTS);
}

function getIdeClient(clientId) {
  return IDE_CLIENTS[normalizeClientId(clientId)] || null;
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
  if (client.id === 'vscode') roots.push(pathImpl.join(home, '.vscode-server', 'extensions'));

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
  IDE_CLIENTS,
  listIdeClients,
  getIdeClient,
  resolveIdeExtensionRoots,
  getIdeConfigPath,
  findIdeClientRecord
};
