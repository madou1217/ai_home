'use strict';

const { resolveHostHomeDir } = require('../../runtime/host-home');
const { resolveAiHomeDir } = require('../../runtime/aih-home');
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
  // 数据根目录的唯一规则在 lib/runtime/aih-home.js（AIH_HOME_DIR / AIH_HOME / AI_HOME 为同义别名）。
  const aiHomeDir = resolveAiHomeDir({ env, path, platform, os });
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
