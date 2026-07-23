'use strict';

let cachedNodePty = null;

function withPlatformPtyOptions(options = {}, platform = process.platform) {
  return {
    ...options,
    ...(platform === 'win32' ? { useConptyDll: true } : {})
  };
}

function assertPtySpawnUsable(ptyModule, options = {}) {
  if (!ptyModule || typeof ptyModule.spawn !== 'function') {
    throw new Error('node_pty_spawn_unavailable');
  }
  if (options.selfTest === false) return ptyModule;
  let child = null;
  const processObj = options.processObj || process;
  try {
    child = ptyModule.spawn(processObj.execPath, ['--version'], withPlatformPtyOptions({
      name: 'xterm-color',
      cols: 20,
      rows: 4,
      cwd: processObj.cwd(),
      env: processObj.env
    }, processObj.platform));
  } finally {
    if (child && typeof child.kill === 'function') {
      try {
        child.kill();
      } catch (_error) {}
    }
  }
  return ptyModule;
}

function requireUsableNodePty(packageName, options = {}) {
  const requireImpl = options.requireImpl || require;
  return assertPtySpawnUsable(requireImpl(packageName), options);
}

function loadNodePty(options = {}) {
  if (cachedNodePty && options.forceReload !== true) return cachedNodePty;
  let primaryError = null;
  try {
    cachedNodePty = requireUsableNodePty('node-pty', options);
    return cachedNodePty;
  } catch (error) {
    primaryError = error;
  }

  try {
    cachedNodePty = requireUsableNodePty('@lydell/node-pty', options);
    return cachedNodePty;
  } catch (_fallbackError) {
    throw primaryError;
  }
}

module.exports = {
  assertPtySpawnUsable,
  loadNodePty,
  withPlatformPtyOptions
};
