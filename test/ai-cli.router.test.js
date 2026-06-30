const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { runAiCliCommandRouter } = require('../lib/cli/commands/ai-cli/router');
const { AIH_SERVER_PROFILE_ID } = require('../lib/account/self-relay-account');
const persistentSession = require('../lib/runtime/persistent-session');

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
}

function tmuxSocket(args) {
  const index = Array.isArray(args) ? args.indexOf('-L') : -1;
  return index >= 0 ? args[index + 1] : '';
}

test('`aih codex` without explicit action uses built-in AIH server profile', () => {
  const runCalls = [];
  const exits = [];

  const processImpl = {
    exit: (code) => exits.push(code)
  };
  const fs = {
    existsSync: () => true
  };

  runAiCliCommandRouter('codex', ['codex'], {
    processImpl,
    fs,
    PROFILES_DIR: '/tmp/aih-test-profiles',
    HOST_HOME_DIR: '/tmp',
    extractActiveEnv: () => null,
    getNextAvailableId: () => '2',
    runCliPty: (cliName, id, forwardArgs) => runCalls.push({ cliName, id, forwardArgs })
  });

  assert.deepEqual(exits, []);
  assert.deepEqual(runCalls, [{ cliName: 'codex', id: AIH_SERVER_PROFILE_ID, forwardArgs: [] }]);
});

test('`aih claude` without explicit action uses built-in AIH server profile', () => {
  const runCalls = [];
  const exits = [];

  runAiCliCommandRouter('claude', ['claude'], {
    processImpl: { exit: (code) => exits.push(code) },
    fs: { existsSync: () => true },
    PROFILES_DIR: '/tmp/aih-test-profiles',
    HOST_HOME_DIR: '/tmp',
    extractActiveEnv: () => null,
    runCliPty: (cliName, id, forwardArgs) => runCalls.push({ cliName, id, forwardArgs })
  });

  assert.deepEqual(exits, []);
  assert.deepEqual(runCalls, [{ cliName: 'claude', id: AIH_SERVER_PROFILE_ID, forwardArgs: [] }]);
});

test('`aih claude .aih-server` explicitly targets built-in AIH server profile', () => {
  const runCalls = [];
  const exits = [];

  runAiCliCommandRouter('claude', ['claude', AIH_SERVER_PROFILE_ID, '--version'], {
    processImpl: { exit: (code) => exits.push(code) },
    fs: { existsSync: () => true },
    PROFILES_DIR: '/tmp/aih-test-profiles',
    HOST_HOME_DIR: '/tmp',
    extractActiveEnv: () => null,
    runCliPty: (cliName, id, forwardArgs) => runCalls.push({ cliName, id, forwardArgs })
  });

  assert.deepEqual(exits, []);
  assert.deepEqual(runCalls, [{ cliName: 'claude', id: AIH_SERVER_PROFILE_ID, forwardArgs: ['--version'] }]);
});

test('`aih claude terminal-icon` is handled by ai-home instead of native passthrough', (t) => {
  const logs = [];
  const errors = [];
  const exits = [];
  const runCalls = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (line = '') => logs.push(String(line));
  console.error = (line = '') => errors.push(String(line));
  t.after(() => {
    console.log = originalLog;
    console.error = originalError;
  });

  runAiCliCommandRouter('claude', ['claude', 'terminal-icon', '--windows-terminal-fragment'], {
    processImpl: {
      env: {},
      exit: (code) => exits.push(code)
    },
    fs,
    PROFILES_DIR: '/tmp/aih-test-profiles',
    HOST_HOME_DIR: '/tmp',
    runCliPty: (cliName, id, forwardArgs) => runCalls.push({ cliName, id, forwardArgs })
  });

  const fragment = JSON.parse(logs.join('\n'));
  assert.deepEqual(exits, [0]);
  assert.deepEqual(errors, []);
  assert.deepEqual(runCalls, []);
  assert.equal(fragment.profiles[0].name, 'AIH Claude');
  assert.equal(fragment.profiles[0].commandline, 'aih claude');
  assert.equal(fragment.profiles[0].icon.endsWith(path.join('assets', 'provider-icons', 'claude.png')), true);
});

test('`aih codex` does not open a new Windows Terminal tab for provider icon', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-router-wt-icon-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const exits = [];
  const spawnCalls = [];
  const runCalls = [];

  runAiCliCommandRouter('codex', ['codex'], {
    processImpl: {
      platform: 'win32',
      env: {
        WT_SESSION: 'session-1',
        WT_PROFILE_ID: '{11111111-1111-1111-1111-111111111111}',
        LOCALAPPDATA: root
      },
      stdout: { isTTY: true },
      cwd: () => 'C:\\work\\ai_home',
      exit: (code) => exits.push(code)
    },
    fs,
    PROFILES_DIR: path.join(root, 'profiles'),
    HOST_HOME_DIR: root,
    wtCommand: 'wt',
    aihCommand: 'aih-dev',
    spawnSync: (command, args, options) => {
      spawnCalls.push({ command, args, options });
      return { status: 0 };
    },
    runCliPty: (cliName, id, forwardArgs) => runCalls.push({ cliName, id, forwardArgs })
  });

  assert.deepEqual(exits, []);
  assert.deepEqual(spawnCalls, []);
  assert.deepEqual(runCalls, [{ cliName: 'codex', id: AIH_SERVER_PROFILE_ID, forwardArgs: [] }]);
  assert.equal(fs.existsSync(path.join(root, 'Microsoft', 'Windows Terminal', 'Fragments', 'AI Home', 'provider-icons.json')), false);
});

test('`aih codex` keeps the current Windows Terminal session when already in a provider profile', () => {
  const runCalls = [];
  const spawnCalls = [];
  const exits = [];
  runAiCliCommandRouter('codex', ['codex'], {
    processImpl: {
      platform: 'win32',
      env: {
        WT_SESSION: 'session-1',
        AIH_WT_PROVIDER_PROFILE: 'codex'
      },
      stdout: { isTTY: true },
      cwd: () => 'C:\\work\\ai_home',
      exit: (code) => exits.push(code)
    },
    fs,
    PROFILES_DIR: 'C:\\aih\\profiles',
    HOST_HOME_DIR: 'C:\\Users\\me',
    spawnSync: (command, args) => {
      spawnCalls.push({ command, args });
      return { status: 0 };
    },
    runCliPty: (cliName, id, forwardArgs) => runCalls.push({ cliName, id, forwardArgs })
  });

  assert.deepEqual(exits, []);
  assert.deepEqual(spawnCalls, []);
  assert.deepEqual(runCalls, [{ cliName: 'codex', id: AIH_SERVER_PROFILE_ID, forwardArgs: [] }]);
});

test('`aih codex` prepares an iTerm2 provider profile before starting PTY on macOS', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-router-iterm2-icon-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runCalls = [];
  const writes = [];
  const env = {
    HOME: root,
    TERM_PROGRAM: 'iTerm.app',
    ITERM_SESSION_ID: 'w0t0p0'
  };

  runAiCliCommandRouter('codex', ['codex'], {
    processImpl: {
      platform: 'darwin',
      env,
      stdout: {
        isTTY: true,
        write: (text) => writes.push(String(text))
      },
      exit: (code) => assert.fail(`unexpected exit ${code}`)
    },
    fs,
    PROFILES_DIR: path.join(root, 'profiles'),
    HOST_HOME_DIR: root,
    aihCommand: 'aih-dev',
    runCliPty: (cliName, id, forwardArgs) => runCalls.push({ cliName, id, forwardArgs })
  });

  const profilePath = path.join(root, 'Library', 'Application Support', 'iTerm2', 'DynamicProfiles', 'provider-icons.json');
  const profiles = JSON.parse(fs.readFileSync(profilePath, 'utf8'));

  assert.deepEqual(runCalls, [{ cliName: 'codex', id: AIH_SERVER_PROFILE_ID, forwardArgs: [] }]);
  assert.equal(writes.join('').includes('\x1b]1337;SetProfile=AIH ChatGPT\x07'), true);
  assert.equal(profiles.Profiles[0].Name, 'AIH ChatGPT');
  assert.equal(profiles.Profiles[0]['Custom Icon Path'].endsWith(path.join('assets', 'provider-icons', 'codex.png')), true);
});

test('`aih codex` auto-writes Warp agent mapping before starting PTY', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-router-warp-icon-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runCalls = [];
  const writes = [];
  const env = {
    HOME: root,
    TERM_PROGRAM: 'WarpTerminal',
    WARP_IS_LOCAL_SHELL_SESSION: '1'
  };

  runAiCliCommandRouter('codex', ['codex'], {
    processImpl: {
      platform: 'darwin',
      env,
      stdout: {
        isTTY: true,
        write: (text) => writes.push(String(text))
      },
      exit: (code) => assert.fail(`unexpected exit ${code}`)
    },
    fs,
    PROFILES_DIR: path.join(root, 'profiles'),
    HOST_HOME_DIR: root,
    runCliPty: (cliName, id, forwardArgs) => runCalls.push({ cliName, id, forwardArgs })
  });

  const settingsPath = path.join(root, '.warp', 'settings.toml');
  const settings = fs.readFileSync(settingsPath, 'utf8');

  assert.deepEqual(runCalls, [{ cliName: 'codex', id: AIH_SERVER_PROFILE_ID, forwardArgs: [] }]);
  assert.equal(settings.includes('"^aih\\\\s+codex(?:\\\\s|$).*" = "Codex"'), true);
  assert.equal(settings.includes('"^aih\\\\s+claude(?:\\\\s|$).*" = "Claude"'), true);
  assert.equal(settings.includes('"^aih\\\\s+gemini(?:\\\\s|$).*" = "Gemini"'), true);
  assert.equal(settings.includes('"^aih\\\\s+opencode(?:\\\\s|$).*" = "OpenCode"'), true);
  assert.equal(settings.includes('"^aih\\\\s+agy(?:\\\\s|$).*" = "Gemini"'), true);
  assert.deepEqual(writes, []);
});

test('`aih codex` prepares and switches a Konsole provider profile before starting PTY on Linux', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-router-konsole-icon-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runCalls = [];
  const spawnCalls = [];
  const env = {
    XDG_DATA_HOME: root,
    KONSOLE_DBUS_SERVICE: 'org.kde.konsole-123',
    KONSOLE_DBUS_SESSION: '/Sessions/1'
  };

  runAiCliCommandRouter('codex', ['codex'], {
    processImpl: {
      platform: 'linux',
      env,
      stdout: { isTTY: true },
      exit: (code) => assert.fail(`unexpected exit ${code}`)
    },
    fs,
    PROFILES_DIR: path.join(root, 'profiles'),
    HOST_HOME_DIR: root,
    qdbusCommand: 'qdbus6',
    spawnSync: (command, args, options) => {
      spawnCalls.push({ command, args, options });
      return { status: 0 };
    },
    runCliPty: (cliName, id, forwardArgs) => runCalls.push({ cliName, id, forwardArgs })
  });

  const profilePath = path.join(root, 'konsole', 'aih-codex.profile');
  const profile = fs.readFileSync(profilePath, 'utf8');

  assert.deepEqual(runCalls, [{ cliName: 'codex', id: AIH_SERVER_PROFILE_ID, forwardArgs: [] }]);
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].command, 'qdbus6');
  assert.equal(spawnCalls[0].args.includes('org.kde.konsole.Session.setProfile'), true);
  assert.equal(profile.includes('Icon=aih-codex'), true);
  assert.equal(fs.existsSync(path.join(root, 'icons', 'hicolor', '256x256', 'apps', 'aih-codex.png')), true);
});

test('`aih claude --resume <session>` forwards native resume args to built-in AIH server profile', () => {
  const runCalls = [];
  const exits = [];
  const usageCalls = [];

  runAiCliCommandRouter('claude', ['claude', '--resume', 'a922845e-d7cd-4909-ae58-a699eb5f812e'], {
    processImpl: { exit: (code) => exits.push(code) },
    fs: { existsSync: () => true },
    PROFILES_DIR: '/tmp/aih-test-profiles',
    HOST_HOME_DIR: '/tmp',
    showCliUsage: (cliName) => usageCalls.push(cliName),
    extractActiveEnv: () => null,
    runCliPty: (cliName, id, forwardArgs) => runCalls.push({ cliName, id, forwardArgs })
  });

  assert.deepEqual(exits, []);
  assert.deepEqual(usageCalls, []);
  assert.deepEqual(runCalls, [{
    cliName: 'claude',
    id: AIH_SERVER_PROFILE_ID,
    forwardArgs: ['--resume', 'a922845e-d7cd-4909-ae58-a699eb5f812e']
  }]);
});

test('`aih claude resume <session>` forwards native resume command to built-in AIH server profile', () => {
  const runCalls = [];
  const exits = [];

  runAiCliCommandRouter('claude', ['claude', 'resume', 'a922845e-d7cd-4909-ae58-a699eb5f812e'], {
    processImpl: { exit: (code) => exits.push(code) },
    fs: { existsSync: () => true },
    PROFILES_DIR: '/tmp/aih-test-profiles',
    HOST_HOME_DIR: '/tmp',
    showCliUsage: () => {
      throw new Error('unexpected_usage');
    },
    extractActiveEnv: () => null,
    runCliPty: (cliName, id, forwardArgs) => runCalls.push({ cliName, id, forwardArgs })
  });

  assert.deepEqual(exits, []);
  assert.deepEqual(runCalls, [{
    cliName: 'claude',
    id: AIH_SERVER_PROFILE_ID,
    forwardArgs: ['resume', 'a922845e-d7cd-4909-ae58-a699eb5f812e']
  }]);
});

test('`aih claude --bare --resume <session>` forwards native flags for hook-free resume', () => {
  const runCalls = [];
  const exits = [];

  runAiCliCommandRouter('claude', ['claude', '--bare', '--resume', 'a922845e-d7cd-4909-ae58-a699eb5f812e'], {
    processImpl: { exit: (code) => exits.push(code) },
    fs: { existsSync: () => true },
    PROFILES_DIR: '/tmp/aih-test-profiles',
    HOST_HOME_DIR: '/tmp',
    showCliUsage: () => {
      throw new Error('unexpected_usage');
    },
    extractActiveEnv: () => null,
    runCliPty: (cliName, id, forwardArgs) => runCalls.push({ cliName, id, forwardArgs })
  });

  assert.deepEqual(exits, []);
  assert.deepEqual(runCalls, [{
    cliName: 'claude',
    id: AIH_SERVER_PROFILE_ID,
    forwardArgs: ['--bare', '--resume', 'a922845e-d7cd-4909-ae58-a699eb5f812e']
  }]);
});

test('`aih claude -p --model` forwards print and model args to built-in AIH server profile', () => {
  const runCalls = [];
  const exits = [];

  runAiCliCommandRouter('claude', ['claude', '-p', '只返回 OK', '--model', 'claude-opus-4.6-thinking'], {
    processImpl: { exit: (code) => exits.push(code) },
    fs: { existsSync: () => true },
    PROFILES_DIR: '/tmp/aih-test-profiles',
    HOST_HOME_DIR: '/tmp',
    showCliUsage: () => {
      throw new Error('unexpected_usage');
    },
    extractActiveEnv: () => null,
    runCliPty: (cliName, id, forwardArgs) => runCalls.push({ cliName, id, forwardArgs })
  });

  assert.deepEqual(exits, []);
  assert.deepEqual(runCalls, [{
    cliName: 'claude',
    id: AIH_SERVER_PROFILE_ID,
    forwardArgs: ['-p', '只返回 OK', '--model', 'claude-opus-4.6-thinking']
  }]);
});

test('`aih codex home` prints built-in profile diagnostics without launching native CLI', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-router-home-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profilesDir = path.join(root, '.ai_home', 'profiles');
  const profileDir = path.join(profilesDir, 'codex', AIH_SERVER_PROFILE_ID);
  fs.mkdirSync(path.join(profileDir, '.codex'), { recursive: true });
  fs.mkdirSync(path.join(profilesDir, 'codex', '1', '.codex'), { recursive: true });
  fs.writeFileSync(path.join(profilesDir, 'codex', '.aih_default'), '1', 'utf8');

  const exits = [];
  const logs = [];
  const originalLog = console.log;
  console.log = (msg) => logs.push(String(msg));
  try {
    runAiCliCommandRouter('codex', ['codex', 'home'], {
      processImpl: {
        env: {
          HOME: path.join(root, '.ai_home', 'profiles', 'codex', '99'),
          CODEX_HOME: '/leaked/codex'
        },
        exit: (code) => exits.push(code)
      },
      fs,
      PROFILES_DIR: profilesDir,
      HOST_HOME_DIR: root,
      runCliPty: () => {
        throw new Error('unexpected_native_launch');
      }
    });
  } finally {
    console.log = originalLog;
  }

  const output = logs.join('\n');
  assert.deepEqual(exits, [0]);
  assert.match(output, /AIH home diagnostics: codex #\.aih-server/);
  assert.equal(output.includes(`HOME=${root}`), true);
  assert.equal(output.includes(`CODEX_HOME=${path.join(profileDir, '.codex')}`), true);
  assert.equal(output.includes(`  HOME=${profileDir}`), false);
});

test('`aih gemini 1 home` prints ID-first diagnostics without launching native CLI', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-router-home-id-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profilesDir = path.join(root, '.ai_home', 'profiles');
  const profileDir = path.join(profilesDir, 'gemini', '1');
  fs.mkdirSync(path.join(profileDir, '.gemini'), { recursive: true });

  const exits = [];
  const logs = [];
  const originalLog = console.log;
  console.log = (msg) => logs.push(String(msg));
  try {
    runAiCliCommandRouter('gemini', ['gemini', '1', 'home'], {
      processImpl: {
        env: { HOME: root },
        exit: (code) => exits.push(code)
      },
      fs,
      PROFILES_DIR: profilesDir,
      HOST_HOME_DIR: root,
      runCliPty: () => {
        throw new Error('unexpected_native_launch');
      }
    });
  } finally {
    console.log = originalLog;
  }

  const output = logs.join('\n');
  assert.deepEqual(exits, [0]);
  assert.match(output, /AIH home diagnostics: gemini #1/);
  assert.equal(output.includes(`HOME=${root}`), true);
  assert.equal(output.includes(`GEMINI_CLI_HOME=${path.join(profileDir, '.gemini')}`), true);
});

test('`aih codex ls <id>` forwards id filter to listProfiles', () => {
  const exits = [];
  const listCalls = [];
  runAiCliCommandRouter('codex', ['codex', 'ls', '24444'], {
    processImpl: { exit: (code) => exits.push(code) },
    fs: { existsSync: () => true },
    listProfiles: (cliName, id) => listCalls.push({ cliName, id }),
    showLsHelp: () => {}
  });
  assert.deepEqual(listCalls, [{ cliName: 'codex', id: '24444' }]);
  assert.deepEqual(exits, [0]);
});

test('`aih codex count` is no longer a valid provider command', () => {
  const exits = [];
  const errors = [];
  const usageCalls = [];
  const originalError = console.error;
  console.error = (msg) => errors.push(String(msg));
  try {
    runAiCliCommandRouter('codex', ['codex', 'count'], {
      processImpl: { exit: (code) => exits.push(code) },
      fs: { existsSync: () => true },
      showCliUsage: (cliName) => usageCalls.push(cliName)
    });
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(exits, [1]);
  assert.deepEqual(usageCalls, ['codex']);
  assert.equal(errors.some((line) => line.includes('Unknown subcommand: count')), true);
});

[
  ['auto', ['codex', 'auto']],
  ['up', ['codex', 'up', '7']]
].forEach(([action, argv]) => {
  test(`aih codex ${action} is no longer a valid provider command`, () => {
    const exits = [];
    const errors = [];
    const usageCalls = [];
    const originalError = console.error;
    console.error = (msg) => errors.push(String(msg));
    try {
      runAiCliCommandRouter('codex', argv, {
        processImpl: { exit: (code) => exits.push(code) },
        fs: { existsSync: () => true },
        showCliUsage: (cliName) => usageCalls.push(cliName),
        getNextAvailableId: () => {
          throw new Error('unexpected_auto_selection');
        },
        setAccountOperationalStatus: () => {
          throw new Error('unexpected_status_update');
        }
      });
    } finally {
      console.error = originalError;
    }
    assert.deepEqual(exits, [1]);
    assert.deepEqual(usageCalls, ['codex']);
    assert.equal(errors.some((line) => line.includes(`Unknown subcommand: ${action}`)), true);
  });
});

test('`aih codex delete 1,2,3` deletes multiple accounts', () => {
  const exits = [];
  const logs = [];
  const originalLog = console.log;
  console.log = (msg) => logs.push(String(msg));
  try {
    runAiCliCommandRouter('codex', ['codex', 'delete', '1,2,3'], {
      processImpl: { exit: (code) => exits.push(code) },
      fs: { existsSync: () => true },
      parseDeleteSelectorTokens: () => ['1', '2', '3'],
      deleteAccountsForCli: () => ({ deletedIds: ['1', '2', '3'], missingIds: [] })
    });
  } finally {
    console.log = originalLog;
  }
  assert.deepEqual(exits, [0]);
  assert.equal(logs.some((line) => line.includes('deleted 3 codex account')), true);
  assert.equal(logs.some((line) => line.includes('1, 2, 3')), true);
});

test('`aih codex delete 1-9` supports range selectors', () => {
  const exits = [];
  const logs = [];
  const originalLog = console.log;
  console.log = (msg) => logs.push(String(msg));
  try {
    runAiCliCommandRouter('codex', ['codex', 'delete', '1-3'], {
      processImpl: { exit: (code) => exits.push(code) },
      fs: { existsSync: () => true },
      parseDeleteSelectorTokens: () => ['1', '2', '3'],
      deleteAccountsForCli: () => ({ deletedIds: ['1', '2'], missingIds: ['3'] })
    });
  } finally {
    console.log = originalLog;
  }
  assert.deepEqual(exits, [0]);
  assert.equal(logs.some((line) => line.includes('deleted 2 codex account')), true);
  assert.equal(logs.some((line) => line.includes('missing: 3')), true);
});

test('`aih codex deleteall` deletes all accounts for a provider', () => {
  const exits = [];
  const logs = [];
  const originalLog = console.log;
  console.log = (msg) => logs.push(String(msg));
  try {
    runAiCliCommandRouter('codex', ['codex', 'deleteall'], {
      processImpl: { exit: (code) => exits.push(code) },
      fs: { existsSync: () => true },
      deleteAllAccountsForCli: () => ({ deletedIds: ['1', '2'], totalBeforeDelete: 2 })
    });
  } finally {
    console.log = originalLog;
  }
  assert.deepEqual(exits, [0]);
  assert.equal(logs.some((line) => line.includes('deleted 2/2 codex account')), true);
});

test('`aih codex 7 down` is no longer a valid id-style command', () => {
  const exits = [];
  const errors = [];
  const statusCalls = [];
  const usageCalls = [];
  const originalError = console.error;
  console.error = (msg) => errors.push(String(msg));
  try {
    runAiCliCommandRouter('codex', ['codex', '7', 'down'], {
      processImpl: { exit: (code) => exits.push(code) },
      fs: { existsSync: () => true },
      getProfileDir: (_cli, id) => `/tmp/codex/${id}`,
      extractActiveEnv: () => null,
      showCliUsage: (cliName) => usageCalls.push(cliName),
      setAccountOperationalStatus: (cliName, id, status) => {
        statusCalls.push({ cliName, id, status });
        return true;
      }
    });
  } finally {
    console.error = originalError;
  }

  assert.deepEqual(statusCalls, []);
  assert.deepEqual(exits, [1]);
  assert.deepEqual(usageCalls, ['codex']);
  assert.equal(errors.some((line) => line.includes('Unknown subcommand: down')), true);
});

test('`aih codex ls foo` returns invalid id error', () => {
  const exits = [];
  const errors = [];
  const originalError = console.error;
  console.error = (msg) => errors.push(String(msg));
  try {
    runAiCliCommandRouter('codex', ['codex', 'ls', 'foo'], {
      processImpl: { exit: (code) => exits.push(code) },
      fs: { existsSync: () => true },
      listProfiles: () => {},
      showLsHelp: () => {}
    });
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(exits, [1]);
  assert.equal(errors.some((line) => line.includes('Invalid ID. Usage: aih codex ls [id]')), true);
});

test('`aih codex login --no-browser` forwards flag to login PTY flow', () => {
  const exits = [];
  const calls = [];
  runAiCliCommandRouter('codex', ['codex', 'login', '--no-browser'], {
    processImpl: { exit: (code) => exits.push(code) },
    fs: { existsSync: () => true },
    extractActiveEnv: () => null,
    getNextId: () => '42',
    createAccount: () => true,
    runCliPty: (cliName, id, forwardArgs, isLogin) => calls.push({ cliName, id, forwardArgs, isLogin })
  });

  assert.deepEqual(exits, []);
  assert.deepEqual(calls, [{
    cliName: 'codex',
    id: '42',
    forwardArgs: ['--no-browser'],
    isLogin: true
  }]);
});

test('`aih codex set-default` does not touch desktop client without explicit flag', () => {
  const exits = [];
  const logs = [];
  const writes = [];
  const restartCalls = [];
  const sessionSyncCalls = [];
  const originalLog = console.log;
  console.log = (msg) => logs.push(String(msg));
  try {
    runAiCliCommandRouter('codex', ['codex', 'set-default', '12'], {
      processImpl: { exit: (code) => exits.push(code) },
      fs: {
        existsSync: (target) => String(target).endsWith('/codex/12'),
        writeFileSync: (target, value) => writes.push({ target, value })
      },
      PROFILES_DIR: '/tmp/aih-test-profiles',
      ensureSessionStoreLinks: (cliName, id) => sessionSyncCalls.push({ cliName, id }),
      syncGlobalConfigToHost: () => ({ ok: true }),
      restartDetectedDesktopClient: (cliName) => {
        restartCalls.push(cliName);
        return { detected: true, restarted: true, clientName: 'Codex' };
      }
    });
  } finally {
    console.log = originalLog;
  }

  assert.deepEqual(restartCalls, []);
  assert.deepEqual(sessionSyncCalls, [{ cliName: 'codex', id: '12' }]);
  assert.deepEqual(writes, [{
    target: '/tmp/aih-test-profiles/codex/.aih_default',
    value: '12'
  }]);
  assert.deepEqual(exits, [0]);
  assert.equal(logs.some((line) => line.includes('Set Account ID 12 as default for codex')), true);
  assert.equal(logs.some((line) => line.includes('desktop client')), false);
});

test('`aih codex unset-default` clears current default pointer without user account id', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-unset-default-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profilesDir = path.join(root, '.ai_home', 'profiles');
  const providerDir = path.join(profilesDir, 'codex');
  fs.mkdirSync(path.join(providerDir, '12'), { recursive: true });
  fs.writeFileSync(path.join(providerDir, '.aih_default'), '12', 'utf8');

  const exits = [];
  const logs = [];
  const originalLog = console.log;
  console.log = (msg) => logs.push(String(msg));
  try {
    runAiCliCommandRouter('codex', ['codex', 'unset-default'], {
      processImpl: { exit: (code) => exits.push(code) },
      fs,
      PROFILES_DIR: profilesDir,
      HOST_HOME_DIR: root
    });
  } finally {
    console.log = originalLog;
  }

  assert.deepEqual(exits, [0]);
  assert.equal(fs.existsSync(path.join(providerDir, '.aih_default')), false);
  assert.equal(logs.some((line) => line.includes('Cleared default account for codex')), true);
});

test('`aih codex unset-default <id>` is rejected because CLI infers the current default', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-unset-default-arg-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profilesDir = path.join(root, '.ai_home', 'profiles');
  const providerDir = path.join(profilesDir, 'codex');
  fs.mkdirSync(path.join(providerDir, '12'), { recursive: true });
  fs.writeFileSync(path.join(providerDir, '.aih_default'), '12', 'utf8');

  const exits = [];
  const errors = [];
  const originalError = console.error;
  console.error = (msg) => errors.push(String(msg));
  try {
    runAiCliCommandRouter('codex', ['codex', 'unset-default', '12'], {
      processImpl: { exit: (code) => exits.push(code) },
      fs,
      PROFILES_DIR: profilesDir,
      HOST_HOME_DIR: root
    });
  } finally {
    console.error = originalError;
  }

  assert.deepEqual(exits, [1]);
  assert.equal(fs.readFileSync(path.join(providerDir, '.aih_default'), 'utf8'), '12');
  assert.equal(errors.some((line) => line.includes('Usage: aih codex unset-default')), true);
});

test('`aih codex set-mobile` writes desktop account id without changing default account', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-set-mobile-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const aiHomeDir = path.join(root, '.ai_home');
  const profilesDir = path.join(aiHomeDir, 'profiles');
  const accountDir = path.join(profilesDir, 'codex', '10009');
  fs.mkdirSync(accountDir, { recursive: true });
  writeJson(path.join(accountDir, '.codex', 'auth.json'), {
    tokens: {
      access_token: 'access-token',
      refresh_token: 'rt_token'
    }
  });
  writeJson(path.join(aiHomeDir, 'codex-desktop-hook-state.json'), {
    enabled: true,
    traceFile: '/tmp/trace.jsonl',
    traceResponses: true,
    desktopAccountId: '10001'
  });

  const exits = [];
  const logs = [];
  const originalLog = console.log;
  console.log = (msg) => logs.push(String(msg));
  try {
    runAiCliCommandRouter('codex', ['codex', 'set-mobile', '10009'], {
      processImpl: { exit: (code) => exits.push(code) },
      fs,
      PROFILES_DIR: profilesDir,
      HOST_HOME_DIR: root
    });
  } finally {
    console.log = originalLog;
  }

  const state = JSON.parse(fs.readFileSync(path.join(aiHomeDir, 'codex-desktop-hook-state.json'), 'utf8'));
  assert.deepEqual(exits, [0]);
  assert.equal(state.desktopAccountId, '10009');
  assert.equal(state.traceFile, '/tmp/trace.jsonl');
  assert.equal(state.traceResponses, true);
  assert.equal(fs.existsSync(path.join(profilesDir, 'codex', '.aih_default')), false);
  assert.equal(logs.some((line) => line.includes('Set Codex Account ID 10009 as Codex App account')), true);
});

test('`aih codex unset-mobile` clears current Codex App account without user account id', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-unset-mobile-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const aiHomeDir = path.join(root, '.ai_home');
  const profilesDir = path.join(aiHomeDir, 'profiles');
  const providerDir = path.join(profilesDir, 'codex');
  fs.mkdirSync(path.join(providerDir, '10009'), { recursive: true });
  fs.writeFileSync(path.join(providerDir, '.aih_default'), '12', 'utf8');
  writeJson(path.join(aiHomeDir, 'codex-desktop-hook-state.json'), {
    enabled: true,
    traceFile: '/tmp/trace.jsonl',
    traceResponses: true,
    remoteControlProxy: true,
    desktopAccountId: '10009'
  });

  const exits = [];
  const logs = [];
  const originalLog = console.log;
  console.log = (msg) => logs.push(String(msg));
  try {
    runAiCliCommandRouter('codex', ['codex', 'unset-mobile'], {
      processImpl: { exit: (code) => exits.push(code) },
      fs,
      PROFILES_DIR: profilesDir,
      HOST_HOME_DIR: root
    });
  } finally {
    console.log = originalLog;
  }

  const state = JSON.parse(fs.readFileSync(path.join(aiHomeDir, 'codex-desktop-hook-state.json'), 'utf8'));
  assert.deepEqual(exits, [0]);
  assert.equal(Object.prototype.hasOwnProperty.call(state, 'desktopAccountId'), false);
  assert.equal(state.traceFile, '/tmp/trace.jsonl');
  assert.equal(state.traceResponses, true);
  assert.equal(state.remoteControlProxy, true);
  assert.equal(fs.readFileSync(path.join(providerDir, '.aih_default'), 'utf8'), '12');
  assert.equal(logs.some((line) => line.includes('Cleared Codex App account')), true);
});

test('`aih codex unset-mobile <id>` is rejected because CLI infers the current mobile account', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-unset-mobile-arg-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const aiHomeDir = path.join(root, '.ai_home');
  const profilesDir = path.join(aiHomeDir, 'profiles');
  writeJson(path.join(aiHomeDir, 'codex-desktop-hook-state.json'), {
    enabled: true,
    desktopAccountId: '10009'
  });

  const exits = [];
  const errors = [];
  const originalError = console.error;
  console.error = (msg) => errors.push(String(msg));
  try {
    runAiCliCommandRouter('codex', ['codex', 'unset-mobile', '10009'], {
      processImpl: { exit: (code) => exits.push(code) },
      fs,
      PROFILES_DIR: profilesDir,
      HOST_HOME_DIR: root
    });
  } finally {
    console.error = originalError;
  }

  const state = JSON.parse(fs.readFileSync(path.join(aiHomeDir, 'codex-desktop-hook-state.json'), 'utf8'));
  assert.deepEqual(exits, [1]);
  assert.equal(state.desktopAccountId, '10009');
  assert.equal(errors.some((line) => line.includes('Usage: aih codex unset-mobile')), true);
});

test('`aih codex set-mobile` rejects api-key accounts', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-set-mobile-apikey-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const aiHomeDir = path.join(root, '.ai_home');
  const profilesDir = path.join(aiHomeDir, 'profiles');
  const accountDir = path.join(profilesDir, 'codex', '10');
  fs.mkdirSync(accountDir, { recursive: true });
  writeJson(path.join(accountDir, '.aih_env.json'), {
    OPENAI_API_KEY: 'sk-test'
  });
  writeJson(path.join(accountDir, '.codex', 'auth.json'), {
    OPENAI_API_KEY: 'sk-test'
  });

  const exits = [];
  const errors = [];
  const originalError = console.error;
  console.error = (msg) => errors.push(String(msg));
  try {
    runAiCliCommandRouter('codex', ['codex', 'set-mobile', '10'], {
      processImpl: { exit: (code) => exits.push(code) },
      fs,
      PROFILES_DIR: profilesDir,
      HOST_HOME_DIR: root
    });
  } finally {
    console.error = originalError;
  }

  assert.deepEqual(exits, [1]);
  assert.equal(errors.some((line) => line.includes('Codex App account requires a usable ChatGPT OAuth account')), true);
  assert.equal(fs.existsSync(path.join(aiHomeDir, 'codex-desktop-hook-state.json')), false);
});

test('`aih codex set-mobile` rejects accounts without usable auth', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-set-mobile-missing-auth-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const aiHomeDir = path.join(root, '.ai_home');
  const profilesDir = path.join(aiHomeDir, 'profiles');
  const accountDir = path.join(profilesDir, 'codex', '11');
  fs.mkdirSync(accountDir, { recursive: true });

  const exits = [];
  const errors = [];
  const originalError = console.error;
  console.error = (msg) => errors.push(String(msg));
  try {
    runAiCliCommandRouter('codex', ['codex', 'set-mobile', '11'], {
      processImpl: { exit: (code) => exits.push(code) },
      fs,
      PROFILES_DIR: profilesDir,
      HOST_HOME_DIR: root
    });
  } finally {
    console.error = originalError;
  }

  assert.deepEqual(exits, [1]);
  assert.equal(errors.some((line) => line.includes('Codex App account requires a usable ChatGPT OAuth account')), true);
  assert.equal(fs.existsSync(path.join(aiHomeDir, 'codex-desktop-hook-state.json')), false);
});

test('`aih codex set-default --restart-client` restarts desktop client as best effort after sync', () => {
  const exits = [];
  const logs = [];
  const restartCalls = [];
  const originalLog = console.log;
  console.log = (msg) => logs.push(String(msg));
  try {
    runAiCliCommandRouter('codex', ['codex', 'set-default', '12', '--restart-client'], {
      processImpl: { exit: (code) => exits.push(code) },
      fs: {
        existsSync: (target) => String(target).endsWith('/codex/12'),
        writeFileSync: () => {}
      },
      PROFILES_DIR: '/tmp/aih-test-profiles',
      syncGlobalConfigToHost: () => ({ ok: true }),
      restartDetectedDesktopClient: (cliName) => {
        restartCalls.push(cliName);
        return { detected: true, restarted: true, clientName: 'Codex' };
      }
    });
  } finally {
    console.log = originalLog;
  }

  assert.deepEqual(restartCalls, ['codex']);
  assert.deepEqual(exits, [0]);
  assert.equal(logs.some((line) => line.includes('Restarted local Codex desktop client')), true);
});

test('`aih codex set-default --restart-client` reports force-quit restart when graceful stop timed out', () => {
  const exits = [];
  const logs = [];
  const originalLog = console.log;
  console.log = (msg) => logs.push(String(msg));
  try {
    runAiCliCommandRouter('codex', ['codex', 'set-default', '12', '--restart-client'], {
      processImpl: { exit: (code) => exits.push(code) },
      fs: {
        existsSync: (target) => String(target).endsWith('/codex/12'),
        writeFileSync: () => {}
      },
      PROFILES_DIR: '/tmp/aih-test-profiles',
      syncGlobalConfigToHost: () => ({ ok: true }),
      restartDetectedDesktopClient: () => ({
        detected: true,
        restarted: true,
        forceQuit: true,
        clientName: 'Codex'
      })
    });
  } finally {
    console.log = originalLog;
  }

  assert.deepEqual(exits, [0]);
  assert.equal(logs.some((line) => line.includes('Force-quit and restarted local Codex desktop client')), true);
});

test('`aih codex set-default --force-quit-client` requests force quit when restarting desktop client', () => {
  const exits = [];
  const logs = [];
  const restartCalls = [];
  const originalLog = console.log;
  console.log = (msg) => logs.push(String(msg));
  try {
    runAiCliCommandRouter('codex', ['codex', 'set-default', '12', '--force-quit-client'], {
      processImpl: { exit: (code) => exits.push(code) },
      fs: {
        existsSync: (target) => String(target).endsWith('/codex/12'),
        writeFileSync: () => {}
      },
      PROFILES_DIR: '/tmp/aih-test-profiles',
      syncGlobalConfigToHost: () => ({ ok: true }),
      restartDetectedDesktopClient: (cliName, options) => {
        restartCalls.push({ cliName, options });
        return {
          detected: true,
          restarted: true,
          forceQuit: true,
          clientName: 'Codex'
        };
      }
    });
  } finally {
    console.log = originalLog;
  }

  assert.deepEqual(restartCalls, [{
    cliName: 'codex',
    options: { forceQuit: true }
  }]);
  assert.deepEqual(exits, [0]);
  assert.equal(logs.some((line) => line.includes('Force-quit and restarted local Codex desktop client')), true);
});

test('`aih codex set-default --restart-client` reminds user to open desktop app first when no learned path exists', () => {
  const exits = [];
  const logs = [];
  const originalLog = console.log;
  console.log = (msg) => logs.push(String(msg));
  try {
    runAiCliCommandRouter('codex', ['codex', 'set-default', '12', '--restart-client'], {
      processImpl: { exit: (code) => exits.push(code) },
      fs: {
        existsSync: (target) => String(target).endsWith('/codex/12'),
        writeFileSync: () => {}
      },
      PROFILES_DIR: '/tmp/aih-test-profiles',
      syncGlobalConfigToHost: () => ({ ok: true }),
      restartDetectedDesktopClient: () => ({
        detected: false,
        restarted: false,
        clientName: 'Codex',
        reason: 'no_saved_path'
      })
    });
  } finally {
    console.log = originalLog;
  }

  assert.deepEqual(exits, [0]);
  assert.equal(logs.some((line) => line.includes('Open Codex desktop app once manually first')), true);
});

test('`aih codex set-default --restart-client` reports direct launch when desktop client was not running', () => {
  const exits = [];
  const logs = [];
  const originalLog = console.log;
  console.log = (msg) => logs.push(String(msg));
  try {
    runAiCliCommandRouter('codex', ['codex', 'set-default', '12', '--restart-client'], {
      processImpl: { exit: (code) => exits.push(code) },
      fs: {
        existsSync: (target) => String(target).endsWith('/codex/12'),
        writeFileSync: () => {}
      },
      PROFILES_DIR: '/tmp/aih-test-profiles',
      syncGlobalConfigToHost: () => ({ ok: true }),
      restartDetectedDesktopClient: () => ({
        detected: false,
        restarted: false,
        launched: true,
        clientName: 'Codex'
      })
    });
  } finally {
    console.log = originalLog;
  }

  assert.deepEqual(exits, [0]);
  assert.equal(logs.some((line) => line.includes('was not running; launched local Codex desktop client')), true);
});

test('`aih codex <id> --no-browser` logs in the same account when unconfigured', () => {
  const calls = [];
  runAiCliCommandRouter('codex', ['codex', '12', '--no-browser'], {
    processImpl: { exit: () => {} },
    fs: { existsSync: () => true },
    extractActiveEnv: () => null,
    getProfileDir: () => '/tmp/aih-test/codex/12',
    checkStatus: () => ({ configured: false, accountName: 'Unknown' }),
    runCliPty: (cliName, id, forwardArgs, isLogin) => calls.push({ cliName, id, forwardArgs, isLogin })
  });
  assert.deepEqual(calls, [{
    cliName: 'codex',
    id: '12',
    forwardArgs: ['--no-browser'],
    isLogin: true
  }]);
});

test('`aih codex <id> --no-browser` creates new account when target account is already configured', () => {
  const calls = [];
  const logs = [];
  const originalLog = console.log;
  console.log = (msg) => logs.push(String(msg));
  try {
    runAiCliCommandRouter('codex', ['codex', '12', '--no-browser'], {
      processImpl: { exit: () => {} },
      fs: { existsSync: () => true },
      extractActiveEnv: () => null,
      getProfileDir: () => '/tmp/aih-test/codex/12',
      checkStatus: () => ({ configured: true, accountName: 'u@example.com' }),
      getNextId: () => '13',
      createAccount: () => true,
      runCliPty: (cliName, id, forwardArgs, isLogin) => calls.push({ cliName, id, forwardArgs, isLogin })
    });
  } finally {
    console.log = originalLog;
  }
  assert.equal(logs.some((line) => line.includes('already logged in') && line.includes('Creating Account 13')), true);
  assert.deepEqual(calls, [{
    cliName: 'codex',
    id: '13',
    forwardArgs: ['--no-browser'],
    isLogin: true
  }]);
});

test('`aih codex usage -j 200` forwards jobs option to usage scan', async () => {
  const exits = [];
  const calls = [];
  runAiCliCommandRouter('codex', ['codex', 'usage', '-j', '200'], {
    processImpl: { exit: (code) => exits.push(code) },
    fs: { existsSync: () => true },
    printAllUsageSnapshots: async (cliName, opts) => { calls.push({ cliName, opts }); }
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [{ cliName: 'codex', opts: { jobs: 200, preflight: false, refresh: false } }]);
  assert.deepEqual(exits, [0]);
});

test('`aih agy usage --refresh` forces re-probe for the all-account scan', async () => {
  const exits = [];
  const calls = [];
  runAiCliCommandRouter('agy', ['agy', 'usage', '--refresh'], {
    processImpl: { exit: (code) => exits.push(code) },
    fs: { existsSync: () => true },
    printAllUsageSnapshots: async (cliName, opts) => { calls.push({ cliName, opts }); }
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [{ cliName: 'agy', opts: { jobs: null, preflight: false, refresh: true } }]);
  assert.deepEqual(exits, [0]);
});

test('`aih agy usage 1 --refresh` maps refresh to a no-cache single account query', async () => {
  const exits = [];
  const calls = [];
  runAiCliCommandRouter('agy', ['agy', 'usage', '1', '--refresh'], {
    processImpl: { exit: (code) => exits.push(code) },
    fs: { existsSync: () => true },
    getProfileDir: () => '/tmp/aih-test/agy/1',
    printUsageSnapshotAsync: async (cliName, id, opts) => { calls.push({ cliName, id, opts }); }
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [{ cliName: 'agy', id: '1', opts: { noCache: true, preflight: false } }]);
  assert.deepEqual(exits, [0]);
});

test('`aih agy usage --preflight` forwards all-account local preflight option', async () => {
  const exits = [];
  const calls = [];
  runAiCliCommandRouter('agy', ['agy', 'usage', '--preflight'], {
    processImpl: { exit: (code) => exits.push(code) },
    fs: { existsSync: () => true },
    printAllUsageSnapshots: async (cliName, opts) => { calls.push({ cliName, opts }); }
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [{ cliName: 'agy', opts: { jobs: null, preflight: true, refresh: false } }]);
  assert.deepEqual(exits, [0]);
});

test('`aih codex usage --jobs 200` is rejected (single -j flag policy)', () => {
  const exits = [];
  const errors = [];
  const originalError = console.error;
  console.error = (msg) => errors.push(String(msg));
  try {
    runAiCliCommandRouter('codex', ['codex', 'usage', '--jobs', '200'], {
      processImpl: { exit: (code) => exits.push(code) },
      fs: { existsSync: () => true },
      printAllUsageSnapshots: async () => {}
    });
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(exits, [1]);
  assert.equal(errors.some((line) => line.includes('Unknown usage scan arg: --jobs')), true);
});

test('`aih codex usage <id> --no-cache` forwards noCache query option', async () => {
  const exits = [];
  const calls = [];
  runAiCliCommandRouter('codex', ['codex', 'usage', '12', '--no-cache'], {
    processImpl: { exit: (code) => exits.push(code) },
    fs: { existsSync: () => true },
    getProfileDir: () => '/tmp/aih-test/codex/12',
    printUsageSnapshotAsync: async (cliName, id, opts) => {
      calls.push({ cliName, id, opts });
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [{
    cliName: 'codex',
    id: '12',
    opts: { noCache: true, preflight: false }
  }]);
  assert.deepEqual(exits, [0]);
});

test('`aih codex <id> usage --no-cache` forwards noCache query option', async () => {
  const exits = [];
  const calls = [];
  runAiCliCommandRouter('codex', ['codex', '12', 'usage', '--no-cache'], {
    processImpl: { exit: (code) => exits.push(code) },
    fs: { existsSync: () => true },
    extractActiveEnv: () => null,
    getProfileDir: () => '/tmp/aih-test/codex/12',
    printUsageSnapshotAsync: async (cliName, id, opts) => {
      calls.push({ cliName, id, opts });
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [{
    cliName: 'codex',
    id: '12',
    opts: { noCache: true, preflight: false }
  }]);
  assert.deepEqual(exits, [0]);
});

test('`aih agy usage <id> --preflight` forwards local preflight query option', async () => {
  const exits = [];
  const calls = [];
  runAiCliCommandRouter('agy', ['agy', 'usage', '3', '--preflight'], {
    processImpl: { exit: (code) => exits.push(code) },
    fs: { existsSync: () => true },
    getProfileDir: () => '/tmp/aih-test/agy/3',
    printUsageSnapshotAsync: async (cliName, id, opts) => {
      calls.push({ cliName, id, opts });
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [{
    cliName: 'agy',
    id: '3',
    opts: { noCache: false, preflight: true }
  }]);
  assert.deepEqual(exits, [0]);
});

test('`aih agy <id> usage --preflight` forwards local preflight query option', async () => {
  const exits = [];
  const calls = [];
  runAiCliCommandRouter('agy', ['agy', '3', 'usage', '--preflight'], {
    processImpl: { exit: (code) => exits.push(code) },
    fs: { existsSync: () => true },
    extractActiveEnv: () => null,
    getProfileDir: () => '/tmp/aih-test/agy/3',
    printUsageSnapshotAsync: async (cliName, id, opts) => {
      calls.push({ cliName, id, opts });
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [{
    cliName: 'agy',
    id: '3',
    opts: { noCache: false, preflight: true }
  }]);
  assert.deepEqual(exits, [0]);
});

test('`aih codex import` routes through unified import with fixed provider', async () => {
  const exits = [];
  const calls = [];
  runAiCliCommandRouter('codex', ['codex', 'import', 'folder1', 'zip1.zip', 'cliproxyapi'], {
    processImpl: { exit: (code) => exits.push(code) },
    fs: { existsSync: () => true },
    renderStageProgress: () => {},
    runUnifiedImport: async (args, opts) => {
      calls.push({ args, opts });
      return {
        providers: ['codex'],
        failedSources: []
      };
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['folder1', 'zip1.zip', 'cliproxyapi']);
  assert.equal(calls[0].opts.provider, 'codex');
  assert.equal(calls[0].opts.log, console.log);
  assert.equal(calls[0].opts.error, console.error);
  assert.equal(typeof calls[0].opts.renderStageProgress, 'function');
  assert.deepEqual(exits, [0]);
});

test('`aih codex cleanup` is no longer a valid provider command', () => {
  const exits = [];
  const errors = [];
  const calls = [];
  const usageCalls = [];
  const originalError = console.error;
  console.error = (msg) => errors.push(String(msg));
  try {
    runAiCliCommandRouter('codex', ['codex', 'cleanup'], {
      processImpl: { exit: (code) => exits.push(code) },
      fs: { existsSync: () => true },
      showCliUsage: (cliName) => usageCalls.push(cliName),
      cleanupCodexAccounts: async (opts) => {
        calls.push(opts);
        return { removedAccounts: [] };
      }
    });
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(exits, [1]);
  assert.deepEqual(calls, []);
  assert.deepEqual(usageCalls, ['codex']);
  assert.equal(errors.some((line) => line.includes('Unknown subcommand: cleanup')), true);
});

// ---------------------------------------------------------------------------
// 原生参数完整穿透（aih {provider} [accountid] [...native args]）
// ---------------------------------------------------------------------------

test('`aih codex goal ...` forwards non-dash native subcommand to built-in AIH server profile', () => {
  const runCalls = [];
  runAiCliCommandRouter('codex', ['codex', 'goal', 'continue'], {
    processImpl: { exit: () => {} },
    fs: { existsSync: () => true },
    extractActiveEnv: () => null,
    runCliPty: (cliName, id, forwardArgs) => runCalls.push({ cliName, id, forwardArgs })
  });
  assert.deepEqual(runCalls, [{ cliName: 'codex', id: AIH_SERVER_PROFILE_ID, forwardArgs: ['goal', 'continue'] }]);
});

test('`aih gemini --resume <session>` (no account id, no server profile) forwards to default account', () => {
  const runCalls = [];
  runAiCliCommandRouter('gemini', ['gemini', '--resume', '334e009d-267c-407d-be2e-253efd0df5ec'], {
    processImpl: { exit: () => {} },
    fs: { existsSync: () => true },
    PROFILES_DIR: '/tmp/aih-test-profiles',
    extractActiveEnv: () => null,
    getProfileDir: () => '/tmp/aih-test/gemini/1',
    checkStatus: () => ({ configured: true, accountName: 'g@example.com' }),
    runCliPty: (cliName, id, forwardArgs) => runCalls.push({ cliName, id, forwardArgs })
  });
  assert.deepEqual(runCalls, [{ cliName: 'gemini', id: '1', forwardArgs: ['--resume', '334e009d-267c-407d-be2e-253efd0df5ec'] }]);
});

test('`aih gemini plan ...` (no account id) forwards native subcommand to default account', () => {
  const runCalls = [];
  runAiCliCommandRouter('gemini', ['gemini', 'plan', 'show'], {
    processImpl: { exit: () => {} },
    fs: { existsSync: () => true },
    PROFILES_DIR: '/tmp/aih-test-profiles',
    extractActiveEnv: () => null,
    getProfileDir: () => '/tmp/aih-test/gemini/1',
    checkStatus: () => ({ configured: true, accountName: 'g@example.com' }),
    runCliPty: (cliName, id, forwardArgs) => runCalls.push({ cliName, id, forwardArgs })
  });
  assert.deepEqual(runCalls, [{ cliName: 'gemini', id: '1', forwardArgs: ['plan', 'show'] }]);
});

test('`aih agy <id> exec ...` forwards native args after explicit account id', () => {
  const runCalls = [];
  runAiCliCommandRouter('agy', ['agy', '3', 'exec', '--foo', 'bar'], {
    processImpl: { exit: () => {} },
    fs: { existsSync: () => true },
    PROFILES_DIR: '/tmp/aih-test-profiles',
    extractActiveEnv: () => null,
    getProfileDir: () => '/tmp/aih-test/agy/3',
    checkStatus: () => ({ configured: true, accountName: 'a@example.com' }),
    runCliPty: (cliName, id, forwardArgs) => runCalls.push({ cliName, id, forwardArgs })
  });
  assert.deepEqual(runCalls, [{ cliName: 'agy', id: '3', forwardArgs: ['exec', '--foo', 'bar'] }]);
});

test('`aih codex sessions <id>` uses injected resolver for Windows psmux', () => {
  const exits = [];
  const logs = [];
  const resolveCalls = [];
  const spawnCalls = [];
  const psmuxPath = 'C:\\Users\\madou\\AppData\\Local\\Microsoft\\WinGet\\Links\\psmux.exe';
  const originalLog = console.log;
  console.log = (msg) => logs.push(String(msg));
  try {
    runAiCliCommandRouter('codex', ['codex', 'sessions', '12'], {
      processImpl: {
        platform: 'win32',
        env: {},
        cwd: () => 'C:\\work\\ai_home',
        exit: (code) => exits.push(code)
      },
      fs: {
        existsSync: () => false
      },
      PROFILES_DIR: 'C:\\aih\\profiles',
      resolveCliPath: (name, options) => {
        resolveCalls.push({ name, options });
        return name === 'psmux' ? psmuxPath : '';
      },
      spawnSync: (command, args, options) => {
        spawnCalls.push({ command, args, options });
        return {
          status: 0,
          stdout: 'p-ai-home-abc123\t0\t100\tC:\\work\\ai_home\r\n'
        };
      }
    });
  } finally {
    console.log = originalLog;
  }

  assert.deepEqual(exits, [0]);
  assert.equal(resolveCalls.length, 1);
  assert.equal(resolveCalls[0].name, 'psmux');
  assert.equal(resolveCalls[0].options.platform, 'win32');
  const setEnvCalls = spawnCalls.filter((call) => call.args.includes('set-environment'));
  const listCall = spawnCalls.find((call) => call.args.includes('list-sessions'));
  assert.equal(setEnvCalls.length, 3);
  assert.equal(setEnvCalls.every((call) => call.command === psmuxPath), true);
  assert.deepEqual(setEnvCalls.map((call) => call.args.slice(-2)), [
    ['LANG', 'C.UTF-8'],
    ['LC_CTYPE', 'C.UTF-8'],
    ['LC_ALL', 'C.UTF-8']
  ]);
  assert.equal(listCall.command, psmuxPath);
  assert.deepEqual(listCall.args.slice(0, 4), ['-u', '-L', 'aih-codex-12', 'list-sessions']);
  assert.equal(logs.some((line) => line.includes('codex#12')), true);
});

test('`aih codex sessions <id>` can install missing Windows psmux then list sessions', () => {
  let installed = false;
  const exits = [];
  const logs = [];
  const spawnCalls = [];
  const psmuxPath = 'C:\\Users\\madou\\AppData\\Local\\Microsoft\\WinGet\\Links\\psmux.exe';
  const originalLog = console.log;
  console.log = (msg) => logs.push(String(msg));
  try {
    runAiCliCommandRouter('codex', ['codex', 'sessions', '12'], {
      processImpl: {
        platform: 'win32',
        env: {
          LOCALAPPDATA: 'C:\\Users\\madou\\AppData\\Local',
          Path: ''
        },
        stdout: { isTTY: true },
        cwd: () => 'C:\\work\\ai_home',
        exit: (code) => exits.push(code)
      },
      fs: {
        existsSync: (target) => target === psmuxPath && installed
      },
      PROFILES_DIR: 'C:\\aih\\profiles',
      resolveCliPath: () => '',
      askYesNo: (query, defaultYes) => {
        logs.push(`${query} default=${defaultYes}`);
        return true;
      },
      spawnSync: (command, args, options) => {
        spawnCalls.push({ command, args, options });
        if (command === 'winget') {
          installed = true;
          return { status: 0 };
        }
        return {
          status: 0,
          stdout: 'p-ai-home-abc123\t0\t100\tC:\\work\\ai_home\r\n'
        };
      }
    });
  } finally {
    console.log = originalLog;
  }

  assert.deepEqual(exits, [0]);
  assert.equal(spawnCalls.length, 5);
  assert.equal(spawnCalls[0].command, 'winget');
  assert.deepEqual(spawnCalls[0].args.slice(0, 4), ['install', '--id', 'marlocarlo.psmux', '--exact']);
  const setEnvCalls = spawnCalls.filter((call) => call.args.includes('set-environment'));
  const listCall = spawnCalls.find((call) => call.args.includes('list-sessions'));
  assert.equal(setEnvCalls.length, 3);
  assert.equal(setEnvCalls.every((call) => call.command === psmuxPath), true);
  assert.equal(listCall.command, psmuxPath);
  assert.deepEqual(listCall.args.slice(0, 4), ['-u', '-L', 'aih-codex-12', 'list-sessions']);
  assert.equal(logs.some((line) => line.includes('psmux')), true);
});

test('`aih codex sessions <id>` respects disabled Windows psmux install prompt', () => {
  const exits = [];
  const logs = [];
  const spawnCalls = [];
  const originalLog = console.log;
  console.log = (msg) => logs.push(String(msg));
  try {
    runAiCliCommandRouter('codex', ['codex', 'sessions', '12'], {
      processImpl: {
        platform: 'win32',
        env: { AIH_PSMUX_INSTALL_PROMPT: '0' },
        stdout: { isTTY: true },
        cwd: () => 'C:\\work\\ai_home',
        exit: (code) => exits.push(code)
      },
      fs: {
        existsSync: () => false
      },
      PROFILES_DIR: 'C:\\aih\\profiles',
      resolveCliPath: () => '',
      askYesNo: () => {
        throw new Error('askYesNo should not be called when psmux install prompt is disabled');
      },
      spawnSync: (command, args, options) => {
        spawnCalls.push({ command, args, options });
        return { status: 0, stdout: '' };
      }
    });
  } finally {
    console.log = originalLog;
  }

  assert.deepEqual(exits, [0]);
  assert.equal(spawnCalls.length, 0);
  assert.equal(logs.some((line) => line.includes('Persistent sessions unavailable')), true);
});

test('`aih codex sessions` hides accounts without live tmux sessions', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-router-sessions-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profilesDir = path.join(root, 'profiles');
  fs.mkdirSync(path.join(profilesDir, 'codex', '1'), { recursive: true });
  fs.mkdirSync(path.join(profilesDir, 'codex', '2'), { recursive: true });
  const sep = persistentSession.SESSION_LIST_SEPARATOR;
  const exits = [];
  const logs = [];
  const originalLog = console.log;
  console.log = (msg) => logs.push(String(msg));
  try {
    runAiCliCommandRouter('codex', ['codex', 'sessions'], {
      processImpl: {
        platform: 'darwin',
        env: {},
        stdout: { isTTY: false },
        cwd: () => '/work/one',
        exit: (code) => exits.push(code)
      },
      fs,
      PROFILES_DIR: profilesDir,
      resolveCliPath: (name) => (name === 'tmux' ? '/usr/bin/tmux' : ''),
      spawnSync: (_command, args) => {
        if (tmuxSocket(args) === 'aih-codex-1') {
          return {
            status: 0,
            stdout: ['p-one', '1', '100', '/work/one', '实现 sessions 选择器', 'codex', 'node'].join(sep)
          };
        }
        return { status: 0, stdout: '' };
      }
    });
  } finally {
    console.log = originalLog;
  }

  assert.deepEqual(exits, [0]);
  assert.equal(logs.some((line) => line.includes('codex#1')), true);
  assert.equal(logs.some((line) => line.includes('GPT #1')), false);
  assert.equal(logs.some((line) => line.includes('◎ GPT #1')), false);
  assert.equal(logs.some((line) => line.includes('codex#2')), false);
  assert.equal(logs.some((line) => line.includes('实现 sessions 选择器')), true);
  assert.equal(logs.some((line) => line.includes('/work/one')), true);
  assert.equal(logs.some((line) => line.includes('- /work/one')), false);
  assert.equal(
    logs.filter((line) => line.includes('实现 sessions 选择器')).every((line) => !line.includes('/work/one')),
    true
  );
});

test('`aih codex sessions` reloads tmux config before listing live sessions', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-router-sessions-conf-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profilesDir = path.join(root, 'profiles');
  fs.mkdirSync(path.join(profilesDir, 'codex', '1'), { recursive: true });
  const spawnCalls = [];
  const exits = [];
  const logs = [];
  const originalLog = console.log;
  console.log = (msg) => logs.push(String(msg));
  try {
    runAiCliCommandRouter('codex', ['codex', 'sessions'], {
      processImpl: {
        platform: 'darwin',
        env: {},
        stdout: { isTTY: false },
        cwd: () => '/work/one',
        exit: (code) => exits.push(code)
      },
      fs,
      PROFILES_DIR: profilesDir,
      resolveCliPath: (name) => (name === 'tmux' ? '/usr/bin/tmux' : ''),
      spawnSync: (_command, args, options) => {
        spawnCalls.push({ args, options });
        if (args.includes('list-sessions')) {
          return { status: 0, stdout: 'p-one\t1\t100\t/work/one\t任务一\tcodex\tnode\n' };
        }
        return { status: 0, stdout: '' };
      }
    });
  } finally {
    console.log = originalLog;
  }

  const confPath = path.join(root, 'persist', 'tmux.conf');
  assert.deepEqual(exits, [0]);
  assert.deepEqual(spawnCalls.map((call) => call.args[3]), [
    'set-environment',
    'set-environment',
    'set-environment',
    'source-file',
    'list-sessions'
  ]);
  assert.deepEqual(spawnCalls.slice(0, 3).map((call) => call.args.slice(-2)), [
    ['LANG', 'en_US.UTF-8'],
    ['LC_CTYPE', 'en_US.UTF-8'],
    ['LC_ALL', 'en_US.UTF-8']
  ]);
  assert.equal(spawnCalls[3].args[4], confPath);
  assert.match(fs.readFileSync(confPath, 'utf8'), /set -g mouse on/);
  assert.equal(logs.some((line) => line.includes('任务一')), true);
});

test('`aih codex sessions` shows agent session title instead of terminal spinner title', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-router-sessions-title-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profilesDir = path.join(root, 'profiles');
  fs.mkdirSync(path.join(profilesDir, 'codex', '1'), { recursive: true });
  const sep = persistentSession.SESSION_LIST_SEPARATOR;
  const exits = [];
  const logs = [];
  const originalLog = console.log;
  console.log = (msg) => logs.push(String(msg));
  try {
    runAiCliCommandRouter('codex', ['codex', 'sessions'], {
      processImpl: {
        platform: 'darwin',
        env: {},
        stdout: { isTTY: false },
        cwd: () => '/work/one',
        exit: (code) => exits.push(code)
      },
      fs,
      PROFILES_DIR: profilesDir,
      HOST_HOME_DIR: '/host/home',
      resolveCliPath: (name) => (name === 'tmux' ? '/usr/bin/tmux' : ''),
      readCodexThreadRecords: ({ hostHomeDir, projectPaths }) => {
        assert.equal(hostHomeDir, '/host/home');
        assert.deepEqual(projectPaths, ['/work/one']);
        return [{
          id: 'thread_1',
          cwd: '/work/one',
          title: '真实 agent 会话标题',
          createdAt: 101,
          updatedAt: 150
        }];
      },
      spawnSync: (_command, args, options) => {
        if (args.includes('list-sessions')) {
          return {
            status: 0,
            stdout: ['p-one', '1', '100', '/work/one', '⠴ [a:1]', 'node', 'node'].join(sep)
          };
        }
        return { status: 0, stdout: '' };
      }
    });
  } finally {
    console.log = originalLog;
  }

  const output = logs.join('\n');
  assert.deepEqual(exits, [0]);
  assert.equal(output.includes('真实 agent 会话标题 (thread_1)'), true);
  assert.equal(output.includes('⠴ [a:1]'), false);
  assert.equal(output.includes('◎ GPT #1'), false);
  assert.equal(output.includes('GPT #1'), false);
  assert.equal(output.includes('codex#1'), true);
});

test('`aih codex sessions` picker enters the selected tmux session in mirror mode', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-router-session-picker-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profilesDir = path.join(root, 'profiles');
  fs.mkdirSync(path.join(profilesDir, 'codex', '1'), { recursive: true });
  fs.mkdirSync(path.join(profilesDir, 'codex', '2'), { recursive: true });
  const sep = persistentSession.SESSION_LIST_SEPARATOR;
  const exits = [];
  const writes = [];
  const rawModeCalls = [];
  const runCalls = [];
  const env = {};
  const keys = ['\x1b[B', '\r'];

  runAiCliCommandRouter('codex', ['codex', 'sessions'], {
    processImpl: {
      platform: 'darwin',
      env,
      stdout: {
        isTTY: true,
        write: (chunk) => writes.push(String(chunk || ''))
      },
      stdin: {
        isTTY: true,
        isRaw: false,
        setRawMode: (enabled) => rawModeCalls.push(Boolean(enabled)),
        resume: () => {},
        isPaused: () => true,
        pause: () => {}
      },
      cwd: () => '/work/one',
      exit: (code) => exits.push(code)
    },
    fs,
    PROFILES_DIR: profilesDir,
    resolveCliPath: (name) => (name === 'tmux' ? '/usr/bin/tmux' : ''),
    agentSessionTitleResolver: (_cliName, sessions) => sessions.map((session) => ({
      ...session,
      agentTitle: session.path === '/work/one' ? '任务一' : '任务二',
      agentSessionId: session.path === '/work/one' ? 'thread-one' : 'thread-two'
    })),
    readSessionPickerKey: () => keys.shift() || '\r',
    spawnSync: (_command, args) => {
      if (tmuxSocket(args) === 'aih-codex-1') {
        return {
          status: 0,
          stdout: ['p-one', '1', '100', '/work/one', '任务一', 'codex', 'node'].join(sep)
        };
      }
      if (tmuxSocket(args) === 'aih-codex-2') {
        return {
          status: 0,
          stdout: ['p-two', '1', '101', '/work/two', '任务二', 'codex', 'node'].join(sep)
        };
      }
      return { status: 0, stdout: '' };
    },
    runCliPty: (cliName, id, forwardArgs) => {
      runCalls.push({
        cliName,
        id,
        forwardArgs,
        target: env[persistentSession.TARGET_ENV],
        mirror: env[persistentSession.MIRROR_ENV]
      });
    }
  });

  assert.deepEqual(exits, []);
  assert.deepEqual(runCalls, [{
    cliName: 'codex',
    id: '2',
    forwardArgs: [],
    target: 'p-two',
    mirror: '1'
  }]);
  assert.deepEqual(rawModeCalls, [true, false]);
  const pickerOutput = writes.join('');
  assert.equal((pickerOutput.match(/\[aih\] 选择要进入的持久会话/g) || []).length, 1);
  assert.equal(pickerOutput.includes('任务一'), true);
  assert.equal(pickerOutput.includes('任务二'), true);
  assert.equal(pickerOutput.includes('任务一 (thread-one)'), true);
  assert.equal(pickerOutput.includes('任务二 (thread-two)'), true);
  const pickerLines = pickerOutput
    .split('\n')
    .map((line) => line.replace(/\r/g, '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, ''));
  assert.equal(pickerLines.some((line) => line === '/work/one'), true);
  assert.equal(pickerLines.some((line) => line === '/work/two'), true);
  assert.equal(pickerLines.some((line) => line.startsWith('- /')), false);
  assert.equal(pickerLines.some((line) => line.startsWith('> - ')), false);
  assert.equal(pickerOutput.includes('◎ GPT #1'), false);
  assert.equal(pickerOutput.includes('GPT #1'), false);
  assert.equal(pickerOutput.includes('codex#1'), true);
  assert.equal(pickerLines.filter((line) => line.includes('任务一')).every((line) => !line.includes('/work/one')), true);
  assert.equal(pickerLines.filter((line) => line.includes('任务二')).every((line) => !line.includes('/work/two')), true);
});

test('`aih codex sessions` picker opens a compatible session for legacy UTF-8 runtime rows', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-router-session-picker-legacy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profilesDir = path.join(root, 'profiles');
  fs.mkdirSync(path.join(profilesDir, 'codex', '1'), { recursive: true });
  const sep = persistentSession.SESSION_LIST_SEPARATOR;
  const exits = [];
  const writes = [];
  const runCalls = [];
  const env = {
    [persistentSession.TARGET_ENV]: 'stale-target',
    [persistentSession.MIRROR_ENV]: '1'
  };
  let cwd = '/work/current';
  const chdirCalls = [];
  const keys = ['\r'];

  runAiCliCommandRouter('codex', ['codex', 'sessions'], {
    processImpl: {
      platform: 'darwin',
      env,
      stdout: {
        isTTY: true,
        columns: 120,
        write: (chunk) => writes.push(String(chunk || ''))
      },
      stdin: {
        isTTY: true,
        isRaw: false,
        setRawMode: () => {},
        resume: () => {},
        isPaused: () => true,
        pause: () => {}
      },
      cwd: () => cwd,
      chdir: (nextCwd) => {
        chdirCalls.push(nextCwd);
        cwd = nextCwd;
      },
      exit: (code) => exits.push(code)
    },
    fs,
    PROFILES_DIR: profilesDir,
    resolveCliPath: (name) => (name === 'tmux' ? '/usr/bin/tmux' : ''),
    agentSessionTitleResolver: (_cliName, sessions) => sessions,
    readSessionPickerKey: () => keys.shift() || '\r',
    spawnSync: (_command, args) => {
      if (args.includes('source-file')) return { status: 0, stdout: '' };
      if (args.includes('list-sessions')) {
        return {
          status: 0,
          stdout: ['p-legacy', '1', '100', '/work/legacy', '旧会话', 'codex', 'node', '123', ''].join(sep)
        };
      }
      return { status: 0, stdout: '' };
    },
    runCliPty: (cliName, id, forwardArgs, isLogin) => {
      runCalls.push({
        cliName,
        id,
        forwardArgs,
        isLogin,
        cwd,
        target: env[persistentSession.TARGET_ENV],
        mirror: env[persistentSession.MIRROR_ENV]
      });
    }
  });

  assert.deepEqual(exits, []);
  assert.deepEqual(chdirCalls, ['/work/legacy', '/work/current']);
  assert.equal(cwd, '/work/current');
  assert.deepEqual(runCalls, [{
    cliName: 'codex',
    id: '1',
    forwardArgs: [],
    isLogin: false,
    cwd: '/work/legacy',
    target: undefined,
    mirror: undefined
  }]);
  assert.equal(writes.join('').includes('[旧 tmux UTF-8 运行时]'), true);
});

test('`aih codex sessions <id>` picker closes the selected tmux session', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-router-session-picker-close-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profilesDir = path.join(root, 'profiles');
  fs.mkdirSync(path.join(profilesDir, 'codex', '1'), { recursive: true });
  const sep = persistentSession.SESSION_LIST_SEPARATOR;
  const exits = [];
  const writes = [];
  const runCalls = [];
  const killCalls = [];
  const env = {};
  let sessionExists = true;
  const keys = ['x'];

  runAiCliCommandRouter('codex', ['codex', 'sessions', '1'], {
    processImpl: {
      platform: 'darwin',
      env,
      stdout: {
        isTTY: true,
        columns: 120,
        write: (chunk) => writes.push(String(chunk || ''))
      },
      stdin: {
        isTTY: true,
        isRaw: false,
        setRawMode: () => {},
        resume: () => {},
        isPaused: () => true,
        pause: () => {}
      },
      cwd: () => '/work/one',
      exit: (code) => exits.push(code)
    },
    fs,
    PROFILES_DIR: profilesDir,
    resolveCliPath: (name) => (name === 'tmux' ? '/usr/bin/tmux' : ''),
    agentSessionTitleResolver: (_cliName, sessions) => sessions,
    readSessionPickerKey: () => keys.shift() || 'q',
    spawnSync: (_command, args) => {
      if (args.includes('source-file')) return { status: 0, stdout: '' };
      if (args.includes('kill-session')) {
        const target = args[args.indexOf('-t') + 1];
        killCalls.push({ socket: tmuxSocket(args), target });
        sessionExists = false;
        return { status: 0 };
      }
      if (args.includes('list-sessions')) {
        return {
          status: 0,
          stdout: sessionExists
            ? ['p-one', '1', '100', '/work/one', '任务一', 'codex', 'node'].join(sep)
            : ''
        };
      }
      return { status: 0, stdout: '' };
    },
    runCliPty: (cliName, id, forwardArgs) => runCalls.push({ cliName, id, forwardArgs })
  });

  assert.deepEqual(exits, [0]);
  assert.deepEqual(runCalls, []);
  assert.deepEqual(killCalls, [{ socket: 'aih-codex-1', target: 'p-one' }]);
  assert.equal(writes.join('').includes('已关闭 codex#1 p-one'), true);
});

test('`aih codex sessions` async picker redraws from the block top without scrolling', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-router-session-picker-async-redraw-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profilesDir = path.join(root, 'profiles');
  fs.mkdirSync(path.join(profilesDir, 'codex', '1'), { recursive: true });
  const sep = persistentSession.SESSION_LIST_SEPARATOR;
  const exits = [];
  const writes = [];
  const runCalls = [];
  const env = {};
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    fd: 0,
    isRaw: false,
    setRawMode: (enabled) => { stdin.isRaw = Boolean(enabled); },
    resume: () => {},
    isPaused: () => false,
    pause: () => {}
  });

  const commandPromise = runAiCliCommandRouter('codex', ['codex', 'sessions'], {
    processImpl: {
      platform: 'darwin',
      env,
      stdout: {
        isTTY: true,
        columns: 100,
        write: (chunk) => writes.push(String(chunk || ''))
      },
      stdin,
      cwd: () => '/work/one',
      exit: (code) => exits.push(code)
    },
    fs,
    PROFILES_DIR: profilesDir,
    resolveCliPath: (name) => (name === 'tmux' ? '/usr/bin/tmux' : ''),
    agentSessionTitleResolver: (_cliName, sessions) => sessions,
    sessionPickerRefreshIntervalMs: 60000,
    spawnSync: (_command, args) => {
      if (args.includes('list-sessions')) {
        return {
          status: 0,
          stdout: [
            ['p-one', '1', '100', '/work/one', '任务一', 'codex', 'node'].join(sep),
            ['p-two', '1', '101', '/work/two', '任务二', 'codex', 'node'].join(sep)
          ].join('\n')
        };
      }
      return { status: 0, stdout: '' };
    },
    runCliPty: (cliName, id, forwardArgs) => {
      runCalls.push({
        cliName,
        id,
        forwardArgs,
        target: env[persistentSession.TARGET_ENV],
        mirror: env[persistentSession.MIRROR_ENV]
      });
    }
  });

  await new Promise((resolve) => setImmediate(resolve));
  stdin.emit('data', Buffer.from('\x1b[B'));
  await new Promise((resolve) => setImmediate(resolve));
  stdin.emit('data', Buffer.from('\r'));
  await commandPromise;

  const output = writes.join('');
  assert.deepEqual(exits, []);
  assert.deepEqual(runCalls, [{
    cliName: 'codex',
    id: '1',
    forwardArgs: [],
    target: 'p-two',
    mirror: '1'
  }]);
  assert.equal(output.includes('\x1b[4A'), true);
  assert.equal(output.includes('\x1b[5A'), false);
});

test('`aih codex sessions` picker refreshes instead of entering a disappeared session', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-router-session-picker-gone-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profilesDir = path.join(root, 'profiles');
  fs.mkdirSync(path.join(profilesDir, 'codex', '1'), { recursive: true });
  const sep = persistentSession.SESSION_LIST_SEPARATOR;
  const exits = [];
  const writes = [];
  const runCalls = [];
  const env = {};
  let listCalls = 0;
  const sessionLine = ['p-one', '1', '100', '/work/one', '快结束的会话', 'codex', 'node'].join(sep);

  runAiCliCommandRouter('codex', ['codex', 'sessions'], {
    processImpl: {
      platform: 'darwin',
      env,
      stdout: {
        isTTY: true,
        write: (chunk) => writes.push(String(chunk || ''))
      },
      stdin: {
        isTTY: true,
        isRaw: false,
        setRawMode: () => {},
        resume: () => {},
        isPaused: () => true,
        pause: () => {}
      },
      cwd: () => '/work/one',
      exit: (code) => exits.push(code)
    },
    fs,
    PROFILES_DIR: profilesDir,
    resolveCliPath: (name) => (name === 'tmux' ? '/usr/bin/tmux' : ''),
    agentSessionTitleResolver: (_cliName, sessions) => sessions,
    readSessionPickerKey: () => '\r',
    spawnSync: (_command, args) => {
      if (!args.includes('list-sessions')) return { status: 0, stdout: '' };
      listCalls += 1;
      return { status: 0, stdout: listCalls <= 2 ? sessionLine : '' };
    },
    runCliPty: (cliName, id, forwardArgs) => runCalls.push({ cliName, id, forwardArgs })
  });

  const output = writes.join('');
  assert.deepEqual(runCalls, []);
  assert.deepEqual(exits, [0]);
  assert.equal(output.includes('所选会话已结束，已刷新列表'), true);
  assert.equal(output.includes('活跃持久会话已全部结束'), true);
});

test('`aih codex sessions` picker keeps header stable and constrains title width', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-router-session-picker-layout-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profilesDir = path.join(root, 'profiles');
  fs.mkdirSync(path.join(profilesDir, 'codex', '1'), { recursive: true });
  const sep = persistentSession.SESSION_LIST_SEPARATOR;
  const writes = [];
  const env = { HOME: '/Users/model' };
  const keys = ['\x1b[B', '\x1b[A', '\r'];
  const longTitle = 'Long agent title '.repeat(8);

  runAiCliCommandRouter('codex', ['codex', 'sessions'], {
    processImpl: {
      platform: 'darwin',
      env,
      stdout: {
        isTTY: true,
        columns: 88,
        write: (chunk) => writes.push(String(chunk || ''))
      },
      stdin: {
        isTTY: true,
        isRaw: false,
        setRawMode: () => {},
        resume: () => {},
        isPaused: () => false,
        pause: () => {}
      },
      cwd: () => '/work/one',
      exit: () => {}
    },
    fs,
    PROFILES_DIR: profilesDir,
    resolveCliPath: (name) => (name === 'tmux' ? '/usr/bin/tmux' : ''),
    agentSessionTitleResolver: (_cliName, sessions) => sessions,
    readSessionPickerKey: () => keys.shift() || '\r',
    spawnSync: (_command, args) => {
      if (args.includes('list-sessions')) {
        return {
          status: 0,
          stdout: [
            ['p-one', '1', '100', '/Users/model/projects/feature/ai_home', longTitle, 'codex', 'node'].join(sep),
            ['p-two', '1', '101', '/Users/model/WebstormProjects/project-admin', '短标题', 'codex', 'node'].join(sep)
          ].join('\n')
        };
      }
      return { status: 0, stdout: '' };
    },
    runCliPty: () => {}
  });

  const output = writes.join('');
  const visibleOutput = output.replace(/\r/g, '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  assert.equal((output.match(/\[aih\] 选择/g) || []).length, 1);
  assert.equal(output.includes(longTitle), false);
  assert.equal(output.includes('Long agent title Long agent title'), true);
  assert.equal(output.includes('Long agent title Long agent title Long agent title'), true);
  assert.equal(visibleOutput.includes('~/projects/feature/ai_home'), true);
  assert.equal(visibleOutput.includes('~/WebstormProjects/project-admin'), true);
  assert.equal(visibleOutput.includes('/Users/model/'), false);
  const sessionLines = visibleOutput
    .split('\n')
    .filter((line) => line.includes('Long agent title') || line.includes('短标题'));
  assert.equal(sessionLines.every((line) => !line.includes('/Users/model/')), true);
});

test('`aih codex sessions` picker keeps waiting when raw tty read is temporarily unavailable', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-router-session-picker-eagain-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profilesDir = path.join(root, 'profiles');
  fs.mkdirSync(path.join(profilesDir, 'codex', '1'), { recursive: true });
  const sep = persistentSession.SESSION_LIST_SEPARATOR;
  const fsWithRetriedRead = Object.create(fs);
  let readAttempts = 0;
  fsWithRetriedRead.readSync = (_fd, buffer) => {
    readAttempts += 1;
    if (readAttempts === 1) {
      const error = new Error('temporarily unavailable');
      error.code = 'EAGAIN';
      throw error;
    }
    buffer.write('\r');
    return 1;
  };
  const exits = [];
  const writes = [];
  const rawModeCalls = [];
  const runCalls = [];
  const env = {};

  runAiCliCommandRouter('codex', ['codex', 'sessions'], {
    processImpl: {
      platform: 'darwin',
      env,
      stdout: {
        isTTY: true,
        write: (chunk) => writes.push(String(chunk || ''))
      },
      stdin: {
        isTTY: true,
        fd: 0,
        isRaw: false,
        setRawMode: (enabled) => rawModeCalls.push(Boolean(enabled)),
        resume: () => {},
        isPaused: () => true,
        pause: () => {}
      },
      cwd: () => '/work/one',
      exit: (code) => exits.push(code)
    },
    fs: fsWithRetriedRead,
    PROFILES_DIR: profilesDir,
    resolveCliPath: (name) => (name === 'tmux' ? '/usr/bin/tmux' : ''),
    forceSyncSessionPicker: true,
    spawnSync: (_command, args) => {
      if (args.includes('list-sessions')) {
        return {
          status: 0,
          stdout: ['p-one', '1', '100', '/work/one', '任务一', 'codex', 'node'].join(sep)
        };
      }
      return { status: 0, stdout: '' };
    },
    runCliPty: (cliName, id, forwardArgs) => {
      runCalls.push({
        cliName,
        id,
        forwardArgs,
        target: env[persistentSession.TARGET_ENV],
        mirror: env[persistentSession.MIRROR_ENV]
      });
    }
  });

  assert.equal(readAttempts, 2);
  assert.deepEqual(exits, []);
  assert.deepEqual(runCalls, [{
    cliName: 'codex',
    id: '1',
    forwardArgs: [],
    target: 'p-one',
    mirror: '1'
  }]);
  assert.deepEqual(rawModeCalls, [true, false]);
  assert.equal(writes.join('').includes('任务一'), true);
});
