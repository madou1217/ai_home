'use strict';

const { resolveHostHomeDir } = require('../../runtime/host-home');

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
  const profilesDir = path.join(aiHomeDir, 'profiles');
  const serverPidFile = path.join(aiHomeDir, 'server.pid');
  const serverLogFile = path.join(aiHomeDir, 'server.log');
  const serverLaunchdPlist = path.join(
    hostHomeDir,
    'Library',
    'LaunchAgents',
    `${launchdLabel}.plist`
  );

  return {
    hostHomeDir,
    aiHomeDir,
    profilesDir,
    serverPidFile,
    serverLogFile,
    serverLaunchdPlist
  };
}

module.exports = {
  resolveCliPaths
};
