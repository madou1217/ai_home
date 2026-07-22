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

  // AIH_HOME is the stable storage identity passed across privilege boundaries.
  // Elevated Windows processes can receive a different USERPROFILE/HOME, so
  // deriving the storage root only from the effective process home would split
  // server config and credentials into a second database.
  const explicitAiHomeDir = String(
    env.AIH_HOME_DIR || env.AIH_HOME || env.AI_HOME || ''
  ).trim();
  const aiHomeDir = explicitAiHomeDir || path.join(hostHomeDir, '.ai_home');
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
