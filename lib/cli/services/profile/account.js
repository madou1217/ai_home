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

    const globalFolder = cliConfigs[cliName] ? cliConfigs[cliName].globalDir : `.${cliName}`;
    const nestedDir = path.join(sandboxDir, globalFolder);
    if (!fs.existsSync(nestedDir)) {
      fs.mkdirSync(nestedDir, { recursive: true });
    }
    const sessionSync = ensureSessionStoreLinks(cliName, id);

    console.log(`\x1b[36m[aih]\x1b[0m Created new sandbox for \x1b[33m${cliName}\x1b[0m (Account ID: \x1b[32m${id}\x1b[0m)`);
    if (sessionSync.migrated > 0 || sessionSync.linked > 0) {
      console.log(`\x1b[36m[aih]\x1b[0m Session links initialized: migrated ${sessionSync.migrated}, linked ${sessionSync.linked}.`);
    }

    if (id === '1' && !skipMigration) {
      const globalPath = path.join(hostHomeDir, globalFolder);

      if (fs.existsSync(globalPath) && fs.readdirSync(globalPath).length > 0) {
        console.log(`\n\x1b[33m[Notice]\x1b[0m Found existing global login state for ${cliName} at ~/${globalFolder}`);
        const ans = askYesNo('Do you want to migrate it to Account 1 as your default account?');
        if (ans !== false) {
          const authFileName = isolatedAuthFileByCli[cliName];
          if (authFileName) {
            const srcAuthPath = path.join(globalPath, authFileName);
            const dstAuthPath = path.join(nestedDir, authFileName);
            if (fs.existsSync(srcAuthPath)) {
              fse.copySync(srcAuthPath, dstAuthPath, { overwrite: true, errorOnExist: false });
            }
          }
          console.log(`\x1b[32m[Success]\x1b[0m Migrated ~/${globalFolder} to Account 1!\n`);
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
