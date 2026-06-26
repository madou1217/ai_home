'use strict';

function createProfileAccountService(options = {}) {
  const {
    fs,
    fse,
    path,
    profilesDir,
    hostHomeDir,
    cliConfigs,
    ensureSessionStoreLinks,
    askYesNo,
    getProfileDir
  } = options;
  const isolatedAuthFileByCli = {
    codex: 'auth.json',
    claude: '.credentials.json',
    gemini: 'google_accounts.json'
  };
  const nonSensitiveHostEntriesByCli = {
    agy: ['settings.json', 'keybindings.json', path.join('cache', 'onboarding.json')]
  };

  function getCliConfig(cliName) {
    return cliConfigs[cliName] || {};
  }

  function getGlobalFolder(cliName) {
    return getCliConfig(cliName).globalDir || `.${cliName}`;
  }

  function getConfigDir(rootDir, cliName) {
    const config = getCliConfig(cliName);
    const globalFolder = getGlobalFolder(cliName);
    const configSubDir = String(config.configSubDir || '').trim();
    return configSubDir
      ? path.join(rootDir, globalFolder, configSubDir)
      : path.join(rootDir, globalFolder);
  }

  function copyNonSensitiveHostEntries(cliName, srcDir, dstDir) {
    const entries = nonSensitiveHostEntriesByCli[cliName] || [];
    let copied = 0;
    entries.forEach((entryName) => {
      const srcPath = path.join(srcDir, entryName);
      if (!fs.existsSync(srcPath)) return;
      const dstPath = path.join(dstDir, entryName);
      fse.copySync(srcPath, dstPath, { overwrite: true, errorOnExist: false });
      copied += 1;
    });
    return copied;
  }

  function hasOpenCodeGlobalState(configDir) {
    if (fs.existsSync(configDir) && fs.readdirSync(configDir).length > 0) return true;
    return fs.existsSync(path.join(hostHomeDir, '.local', 'share', 'opencode', 'auth.json'));
  }

  function copyOpenCodeGlobalState(sandboxDir) {
    const srcAuthPath = path.join(hostHomeDir, '.local', 'share', 'opencode', 'auth.json');
    if (fs.existsSync(srcAuthPath)) {
      const dstAuthPath = path.join(sandboxDir, '.local', 'share', 'opencode', 'auth.json');
      fse.copySync(srcAuthPath, dstAuthPath, { overwrite: true, errorOnExist: false });
    }
  }

  function getNextId(cliName) {
    const toolDir = path.join(profilesDir, cliName);
    if (!fs.existsSync(toolDir)) return '1';
    const ids = fs.readdirSync(toolDir)
      .filter((f) => /^\d+$/.test(f) && fs.statSync(path.join(toolDir, f)).isDirectory())
      .map((n) => parseInt(n, 10))
      .sort((a, b) => a - b);

    if (ids.length === 0) return '1';
    return String(ids[ids.length - 1] + 1);
  }

  function createAccount(cliName, id, skipMigration = false) {
    const sandboxDir = getProfileDir(cliName, id);
    fs.mkdirSync(sandboxDir, { recursive: true });

    const globalFolder = getGlobalFolder(cliName);
    const nestedDir = getConfigDir(sandboxDir, cliName);
    if (!fs.existsSync(nestedDir)) {
      fs.mkdirSync(nestedDir, { recursive: true });
    }
    const sessionSync = ensureSessionStoreLinks(cliName, id);

    console.log(`\x1b[36m[aih]\x1b[0m Created new sandbox for \x1b[33m${cliName}\x1b[0m (Account ID: \x1b[32m${id}\x1b[0m)`);
    if (sessionSync.migrated > 0 || sessionSync.linked > 0) {
      console.log(`\x1b[36m[aih]\x1b[0m Session links initialized: migrated ${sessionSync.migrated}, linked ${sessionSync.linked}.`);
    }

    if (id === '1' && !skipMigration) {
      const globalPath = getConfigDir(hostHomeDir, cliName);

      const hasGlobalState = cliName === 'opencode'
        ? hasOpenCodeGlobalState(globalPath)
        : (fs.existsSync(globalPath) && fs.readdirSync(globalPath).length > 0);
      if (hasGlobalState) {
        const configSubDir = String(getCliConfig(cliName).configSubDir || '').trim();
        const displayPath = configSubDir ? `${globalFolder}/${configSubDir}` : globalFolder;
        console.log(`\n\x1b[33m[Notice]\x1b[0m Found existing global login state for ${cliName} at ~/${displayPath}`);
        const ans = askYesNo('Do you want to migrate it to Account 1 as your default account?');
        if (ans !== false) {
          if (cliName === 'opencode') {
            copyOpenCodeGlobalState(sandboxDir);
          } else {
            const authFileName = isolatedAuthFileByCli[cliName];
            if (authFileName) {
            const srcAuthPath = path.join(globalPath, authFileName);
            const dstAuthPath = path.join(nestedDir, authFileName);
            if (fs.existsSync(srcAuthPath)) {
              fse.copySync(srcAuthPath, dstAuthPath, { overwrite: true, errorOnExist: false });
            }
            }
          }
          copyNonSensitiveHostEntries(cliName, globalPath, nestedDir);
          console.log(`\x1b[32m[Success]\x1b[0m Migrated ~/${displayPath} to Account 1!\n`);
          return false;
        }
      }
    }
    return true;
  }

  return {
    getNextId,
    createAccount
  };
}

module.exports = {
  createProfileAccountService
};
