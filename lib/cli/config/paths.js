'use strict';

const { resolveHostHomeDir } = require('../../runtime/host-home');
const { resolveAihLogPath, resolveAihRunPath } = require('../../runtime/aih-storage-layout');

function resolveCliPaths(options = {}) {
  const {
    path,
    env,
    platform,
    os,
    launchdLabel
  } = options;

  // Resolve the real host home first (works across nested sandbox HOME values).
  const hostHomeDir = resolveHostHomeDir({ env, platform, os });

  // Derive all CLI runtime paths from a single root to keep pathing deterministic.
  const aiHomeDir = path.join(hostHomeDir, '.ai_home');
  const serverPidFile = resolveAihRunPath(aiHomeDir, 'server.pid');
  const serverLogFile = resolveAihLogPath(aiHomeDir, 'server.log');
  const serverLaunchdPlist = path.join(
    hostHomeDir,
    'Library',
    'LaunchAgents',
    `${launchdLabel}.plist`
  );

  return {
    hostHomeDir,
    aiHomeDir,
    serverPidFile,
    serverLogFile,
    serverLaunchdPlist
  };
}

module.exports = {
  resolveCliPaths
};
