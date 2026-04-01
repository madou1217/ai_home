'use strict';

function createProfileLayoutService(options = {}) {
  const {
    fs,
    path,
    profilesDir
  } = options;

  function ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  function getProfileDir(cliName, id) {
    return path.join(profilesDir, cliName, String(id));
  }

  return {
    ensureDir,
    getProfileDir
  };
}

module.exports = {
  createProfileLayoutService
};
