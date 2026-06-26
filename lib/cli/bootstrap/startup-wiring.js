'use strict';

const { resolveCliPaths } = require('../config/paths');
const { configureConsoleEncoding } = require('../../runtime/platform-runtime');
const { createProfileLayoutService } = require('../services/profile/layout');

function createStartupWiring(deps = {}, factories = {}) {
  const resolvePaths = factories.resolveCliPaths || resolveCliPaths;
  const configureEncoding = factories.configureConsoleEncoding || configureConsoleEncoding;
  const buildProfileLayoutService = factories.createProfileLayoutService || createProfileLayoutService;

  const runtimePaths = resolvePaths({
    path: deps.path,
    env: deps.env,
    platform: deps.platform,
    os: deps.os,
    launchdLabel: deps.launchdLabel
  });

  configureEncoding();

  const profileLayoutService = buildProfileLayoutService({
    fs: deps.fs,
    path: deps.path,
    profilesDir: runtimePaths.profilesDir
  });
  const { ensureDir, getProfileDir } = profileLayoutService;

  return {
    hostHomeDir: runtimePaths.hostHomeDir,
    aiHomeDir: runtimePaths.aiHomeDir,
    profilesDir: runtimePaths.profilesDir,
    serverPidFile: runtimePaths.serverPidFile,
    serverLogFile: runtimePaths.serverLogFile,
    serverLaunchdPlist: runtimePaths.serverLaunchdPlist,
    ensureDir,
    getProfileDir
  };
}

module.exports = {
  createStartupWiring
};
