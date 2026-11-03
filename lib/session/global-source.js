const path = require('path');

function resolveGlobalToolConfigRoot(cliName, hostHomeDir, cliConfigs) {
  if (!cliName) {
    throw new Error('cliName is required to resolve global tool config root.');
  }
  if (!hostHomeDir) {
    throw new Error('hostHomeDir is required to resolve global tool config root.');
  }
  const globalFolder = cliConfigs && cliConfigs[cliName]
    ? cliConfigs[cliName].globalDir
    : `.${cliName}`;
  return path.join(hostHomeDir, globalFolder);
}

function resolveSessionStoreRoot(cliName, hostHomeDir, cliConfigs) {
  // Session source must always map to the native global tool directory so
  // native CLI runs and sandboxed runs read/write the same session history.
  return resolveGlobalToolConfigRoot(cliName, hostHomeDir, cliConfigs);
}

module.exports = {
  resolveGlobalToolConfigRoot,
  resolveSessionStoreRoot
};
