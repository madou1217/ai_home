const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');

const {
  buildIterm2SetProfileSequence,
  buildProviderTerminalTitle,
  buildTerminalTitleSequence,
  buildKonsoleProfile,
  buildKonsoleSetProfileCommand,
  buildLinuxDesktopEntry,
  buildWindowsTerminalLaunchCommand,
  buildWindowsTerminalFragment,
  detectTerminalIconStrategy,
  buildIterm2DynamicProfile,
  isWindowsTerminalProviderProfileActive,
  listTerminalIconStrategies,
  prepareCurrentTerminalProviderIcon,
  resolveIterm2DynamicProfilePath,
  resolveKonsoleProfilePath,
  resolveWarpSettingsPath,
  resolveLinuxDesktopEntryPath,
  resolveLinuxIconPath,
  resolveProviderTerminalIconPath,
  resolveWindowsTerminalFragmentPath,
  runTerminalIconCommand,
  stableGuidForProvider,
  writeWarpAgentCommandSettings,
  writeIterm2DynamicProfiles,
  writeLinuxTerminalIconFiles,
  writeWindowsTerminalFragment
} = require('../lib/cli/services/terminal-icons');

test('terminal icon strategies cover default and mainstream terminals separately', () => {
  const strategies = listTerminalIconStrategies();
  const byId = new Map(strategies.map((strategy) => [strategy.id, strategy]));

  [
    'windows-terminal',
    'windows-console-host',
    'apple-terminal',
    'gnome-terminal',
    'konsole',
    'iterm2',
    'warp',
    'wezterm',
    'kitty',
    'alacritty',
    'ghostty',
    'vscode'
  ].forEach((id) => assert.equal(byId.has(id), true, id));

  assert.equal(byId.get('windows-terminal').graphicalIconMode, 'profile-icon');
  assert.equal(byId.get('iterm2').runtimeActivation, 'osc-1337-set-profile');
  assert.equal(byId.get('konsole').runtimeActivation, 'dbus-set-profile');
  assert.equal(byId.get('apple-terminal').titleFallback, true);
  assert.equal(byId.get('gnome-terminal').graphicalIconMode, 'launcher-icon');
  assert.equal(byId.get('warp').graphicalIconMode, 'agent-command');
  assert.equal(byId.get('warp').runtimeActivation, 'settings-agent-command');
  assert.equal(byId.get('warp').titleFallback, true);
});

test('terminal icon strategy detection prefers exact terminal environment markers', () => {
  assert.equal(
    detectTerminalIconStrategy({ platform: 'darwin', env: { TERM_PROGRAM: 'Apple_Terminal' } }).id,
    'apple-terminal'
  );
  assert.equal(
    detectTerminalIconStrategy({ platform: 'darwin', env: { TERM_PROGRAM: 'iTerm.app', ITERM_SESSION_ID: 'w0t0p0' } }).id,
    'iterm2'
  );
  assert.equal(
    detectTerminalIconStrategy({ platform: 'win32', env: { WT_SESSION: '1' } }).id,
    'windows-terminal'
  );
  assert.equal(
    detectTerminalIconStrategy({ platform: 'linux', env: { GNOME_TERMINAL_SCREEN: '/screen' } }).id,
    'gnome-terminal'
  );
  assert.equal(
    detectTerminalIconStrategy({ platform: 'linux', env: { TERM: 'xterm-kitty', KITTY_WINDOW_ID: '1' } }).id,
    'kitty'
  );
  assert.equal(
    detectTerminalIconStrategy({ platform: 'darwin', env: { TERM_PROGRAM: 'WarpTerminal', WARP_IS_LOCAL_SHELL_SESSION: '1' } }).id,
    'warp'
  );
  assert.equal(
    detectTerminalIconStrategy({ platform: 'darwin', env: {} }).id,
    'apple-terminal'
  );
  assert.equal(
    detectTerminalIconStrategy({ platform: 'linux', env: {} }).id,
    'gnome-terminal'
  );
});

test('provider terminal icon paths resolve to real PNG assets', () => {
  const codexIcon = resolveProviderTerminalIconPath('codex');
  const claudeIcon = resolveProviderTerminalIconPath('claude');

  assert.equal(path.basename(codexIcon), 'codex.png');
  assert.equal(path.basename(claudeIcon), 'claude.png');
  assert.equal(fs.existsSync(codexIcon), true);
  assert.equal(fs.existsSync(claudeIcon), true);
});

test('windows terminal fragment uses provider profile icons', () => {
  const fragment = buildWindowsTerminalFragment(['codex', 'claude'], {
    repoRoot: '/repo',
    path
  });

  assert.deepEqual(
    fragment.profiles.map((profile) => ({
      guid: profile.guid,
      name: profile.name,
      commandline: profile.commandline,
      icon: profile.icon,
      hidden: profile.hidden
    })),
    [
      {
        guid: stableGuidForProvider('codex'),
        name: 'AIH ChatGPT',
        commandline: 'aih codex',
        icon: path.resolve('/repo', 'assets/provider-icons/codex.png'),
        hidden: false
      },
      {
        guid: stableGuidForProvider('claude'),
        name: 'AIH Claude',
        commandline: 'aih claude',
        icon: path.resolve('/repo', 'assets/provider-icons/claude.png'),
        hidden: false
      }
    ]
  );
});

test('windows terminal profile detection matches stable provider guid', () => {
  assert.equal(
    isWindowsTerminalProviderProfileActive('codex', {
      WT_PROFILE_ID: stableGuidForProvider('codex')
    }),
    true
  );
  assert.equal(
    isWindowsTerminalProviderProfileActive('codex', {
      WT_PROFILE_ID: stableGuidForProvider('claude')
    }),
    false
  );
});

test('windows terminal launch command opens the provider profile', () => {
  const launch = buildWindowsTerminalLaunchCommand('codex', ['--resume', 'thread-1'], {
    cwd: 'C:\\work\\ai_home',
    aihCommand: 'aih-dev',
    wtCommand: 'wt'
  });

  assert.equal(launch.command, 'wt');
  assert.deepEqual(launch.args.slice(0, 5), ['-w', '0', 'new-tab', '--profile', stableGuidForProvider('codex')]);
  assert.equal(launch.args.includes('--startingDirectory'), true);
  assert.deepEqual(launch.args.slice(-4), ['aih-dev', 'codex', '--resume', 'thread-1']);
  assert.equal(launch.env.AIH_WT_PROVIDER_PROFILE, 'codex');
});

test('windows terminal fragment path follows LOCALAPPDATA fragments layout', () => {
  assert.equal(
    resolveWindowsTerminalFragmentPath({
      path,
      env: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }
    }),
    'C:\\Users\\me\\AppData\\Local\\Microsoft\\Windows Terminal\\Fragments\\AI Home\\provider-icons.json'
  );
});

test('writeWindowsTerminalFragment writes installable JSON', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-terminal-icons-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const targetPath = path.join(root, 'provider-icons.json');

  const result = writeWindowsTerminalFragment(['claude'], {
    fs,
    path,
    targetPath,
    repoRoot: '/repo'
  });
  const written = JSON.parse(fs.readFileSync(targetPath, 'utf8'));

  assert.equal(result.path, targetPath);
  assert.equal(written.profiles.length, 1);
  assert.equal(written.profiles[0].name, 'AIH Claude');
  assert.equal(written.profiles[0].icon, path.resolve('/repo', 'assets/provider-icons/claude.png'));
});

test('iterm2 dynamic profile uses a real provider icon path', () => {
  const profile = buildIterm2DynamicProfile('codex', {
    repoRoot: '/repo',
    aihCommand: 'aih-dev'
  });

  assert.equal(profile.Name, 'AIH ChatGPT');
  assert.equal(profile.Command, 'aih-dev codex');
  assert.equal(profile.Icon, 2);
  assert.equal(profile['Custom Icon Path'], path.resolve('/repo', 'assets/provider-icons/codex.png'));
});

test('writeIterm2DynamicProfiles writes iTerm2 DynamicProfiles JSON under HOME', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-iterm2-icons-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const result = writeIterm2DynamicProfiles(['codex', 'claude'], {
    fs,
    path,
    env: { HOME: root },
    repoRoot: '/repo'
  });
  const written = JSON.parse(fs.readFileSync(result.path, 'utf8'));

  assert.equal(result.path, path.join(root, 'Library', 'Application Support', 'iTerm2', 'DynamicProfiles', 'provider-icons.json'));
  assert.equal(written.Profiles.length, 2);
  assert.equal(written.Profiles[0].Name, 'AIH ChatGPT');
  assert.equal(written.Profiles[0]['Custom Icon Path'], path.resolve('/repo', 'assets/provider-icons/codex.png'));
});

test('iterm2 profile activation writes profile file and SetProfile escape sequence', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-iterm2-activate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const writes = [];
  const env = {
    HOME: root,
    TERM_PROGRAM: 'iTerm.app',
    ITERM_SESSION_ID: 'w0t0p0'
  };

  const result = prepareCurrentTerminalProviderIcon('codex', {
    fs,
    path,
    env,
    processImpl: {
      platform: 'darwin',
      env,
      stdout: {
        isTTY: true,
        write: (text) => writes.push(text)
      }
    },
    repoRoot: '/repo'
  });

  assert.deepEqual(result, { applied: true, terminal: 'iterm2' });
  assert.equal(writes.join(''), buildIterm2SetProfileSequence('codex'));
  assert.equal(fs.existsSync(resolveIterm2DynamicProfilePath({ path, env })), true);
});

test('default macOS Terminal receives provider title badge fallback', () => {
  const writes = [];
  const env = {
    TERM_PROGRAM: 'Apple_Terminal'
  };

  const result = prepareCurrentTerminalProviderIcon('codex', {
    env,
    processImpl: {
      platform: 'darwin',
      env,
      stdout: {
        isTTY: true,
        write: (text) => writes.push(text)
      }
    }
  });

  assert.deepEqual(result, { applied: true, terminal: 'apple-terminal' });
  assert.equal(writes.join(''), buildTerminalTitleSequence(buildProviderTerminalTitle('codex')));
  assert.equal(env.AIH_TERMINAL_PROVIDER_TITLE, 'codex');
});

test('mainstream terminals without portable tab icon APIs use title fallback', () => {
  for (const [terminal, env, platform] of [
    ['wezterm', { WEZTERM_PANE: '1' }, 'linux'],
    ['kitty', { KITTY_WINDOW_ID: '1', TERM: 'xterm-kitty' }, 'linux'],
    ['alacritty', { ALACRITTY_WINDOW_ID: '1' }, 'linux'],
    ['ghostty', { TERM_PROGRAM: 'Ghostty' }, 'darwin'],
    ['vscode', { TERM_PROGRAM: 'vscode' }, 'darwin']
  ]) {
    const writes = [];
    const result = prepareCurrentTerminalProviderIcon('claude', {
      env,
      processImpl: {
        platform,
        env,
        stdout: {
          isTTY: true,
          write: (text) => writes.push(text)
        }
      }
    });

    assert.deepEqual(result, { applied: true, terminal });
    assert.equal(writes.join(''), buildTerminalTitleSequence(buildProviderTerminalTitle('claude')));
  }
});

test('terminal title fallback respects explicit disable flag', () => {
  const writes = [];
  const env = {
    TERM_PROGRAM: 'Apple_Terminal',
    AIH_TERMINAL_TITLE_AUTO: '0'
  };

  const result = prepareCurrentTerminalProviderIcon('codex', {
    env,
    processImpl: {
      platform: 'darwin',
      env,
      stdout: {
        isTTY: true,
        write: (text) => writes.push(text)
      }
    }
  });

  assert.deepEqual(result, { applied: false, terminal: 'apple-terminal' });
  assert.deepEqual(writes, []);
});

test('linux terminal icon install writes XDG icon, desktop entry, and Konsole profile', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-linux-icons-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const result = writeLinuxTerminalIconFiles(['codex'], {
    fs,
    path,
    env: { XDG_DATA_HOME: root },
    repoRoot: REPO_ROOT,
    aihCommand: '/usr/local/bin/aih'
  });
  const entry = result.entries[0];
  const desktopEntry = fs.readFileSync(entry.desktopEntryPath, 'utf8');
  const konsoleProfile = fs.readFileSync(entry.konsoleProfilePath, 'utf8');

  assert.equal(entry.iconPath, resolveLinuxIconPath('codex', { path, env: { XDG_DATA_HOME: root } }));
  assert.equal(entry.desktopEntryPath, resolveLinuxDesktopEntryPath('codex', { path, env: { XDG_DATA_HOME: root } }));
  assert.equal(entry.konsoleProfilePath, resolveKonsoleProfilePath('codex', { path, env: { XDG_DATA_HOME: root } }));
  assert.equal(fs.existsSync(entry.iconPath), true);
  assert.equal(desktopEntry.includes('Icon=aih-codex'), true);
  assert.equal(desktopEntry.includes('Terminal=true'), true);
  assert.equal(desktopEntry.includes('Exec=/usr/local/bin/aih codex'), true);
  assert.equal(konsoleProfile.includes('Icon=aih-codex'), true);
  assert.equal(konsoleProfile.includes('Command=/usr/local/bin/aih'), true);
});

test('linux desktop and Konsole profiles use provider icon names', () => {
  assert.equal(buildLinuxDesktopEntry('claude').includes('Icon=aih-claude'), true);
  assert.equal(buildKonsoleProfile('claude').includes('Icon=aih-claude'), true);
});

test('konsole activation command targets the current DBus session profile', () => {
  const command = buildKonsoleSetProfileCommand('codex', {
    env: {
      KONSOLE_DBUS_SERVICE: 'org.kde.konsole-123',
      KONSOLE_DBUS_SESSION: '/Sessions/1'
    },
    qdbusCommand: 'qdbus6'
  });

  assert.deepEqual(command, {
    command: 'qdbus6',
    args: ['org.kde.konsole-123', '/Sessions/1', 'org.kde.konsole.Session.setProfile', 'AIH ChatGPT']
  });
});

test('terminal icon command installs current macOS platform as iTerm2 profiles', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-install-iterm2-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const logs = [];
  const errors = [];
  const code = runTerminalIconCommand('codex', ['--install'], {
    fs,
    path,
    consoleImpl: {
      log: (line) => logs.push(String(line)),
      error: (line) => errors.push(String(line))
    },
    processImpl: {
      platform: 'darwin',
      env: { HOME: root }
    },
    repoRoot: '/repo'
  });

  assert.equal(code, 0);
  assert.deepEqual(errors, []);
  assert.equal(logs.some((line) => line.includes('iTerm2 provider icon dynamic profiles written')), true);
  assert.equal(fs.existsSync(path.join(root, 'Library', 'Application Support', 'iTerm2', 'DynamicProfiles', 'provider-icons.json')), true);
});

test('terminal icon command prints iTerm2 dynamic profiles when explicitly requested with json', () => {
  const logs = [];
  const errors = [];
  const code = runTerminalIconCommand('codex', ['--iterm2-dynamic-profile', '--json'], {
    consoleImpl: {
      log: (line) => logs.push(String(line)),
      error: (line) => errors.push(String(line))
    },
    processImpl: { env: {} },
    repoRoot: '/repo'
  });
  const payload = JSON.parse(logs.join('\n'));

  assert.equal(code, 0);
  assert.deepEqual(errors, []);
  assert.equal(payload.Profiles[0].Name, 'AIH ChatGPT');
  assert.equal(payload.Profiles[0]['Custom Icon Path'], path.resolve('/repo', 'assets/provider-icons/codex.png'));
});

test('terminal icon command installs current Linux platform icons', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-install-linux-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const logs = [];
  const errors = [];
  const code = runTerminalIconCommand('codex', ['--install'], {
    fs,
    path,
    consoleImpl: {
      log: (line) => logs.push(String(line)),
      error: (line) => errors.push(String(line))
    },
    processImpl: {
      platform: 'linux',
      env: { XDG_DATA_HOME: root }
    },
    repoRoot: REPO_ROOT
  });

  assert.equal(code, 0);
  assert.deepEqual(errors, []);
  assert.equal(logs.some((line) => line.includes('Linux terminal provider icons written')), true);
  assert.equal(fs.existsSync(path.join(root, 'applications', 'aih-codex.desktop')), true);
  assert.equal(fs.existsSync(path.join(root, 'konsole', 'aih-codex.profile')), true);
  assert.equal(fs.existsSync(path.join(root, 'icons', 'hicolor', '256x256', 'apps', 'aih-codex.png')), true);
});

test('warp agent command settings preserve existing custom mappings', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-install-warp-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const settingsPath = path.join(root, '.warp', 'settings.toml');
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, [
    '[ui]',
    'theme = "system"',
    '',
    '[agents.third_party.cli_agent_toolbar_enabled_commands]',
    '"^aih\\\\s+codex(?:\\\\s|$).*" = "Old Codex"',
    '"^custom" = "Custom Agent"',
    ''
  ].join('\n'));

  const result = writeWarpAgentCommandSettings(['codex'], {
    fs,
    path,
    platform: 'darwin',
    env: { HOME: root }
  });
  const content = fs.readFileSync(settingsPath, 'utf8');

  assert.equal(result.path, settingsPath);
  assert.equal(result.entries[0].agentName, 'Codex');
  assert.equal(result.changed, true);
  assert.equal(content.includes('"^custom" = "Custom Agent"'), true);
  assert.equal(content.includes('"^aih\\\\s+codex(?:\\\\s|$).*" = "Codex"'), true);
  assert.equal(content.includes('Old Codex'), false);
});

test('warp provider icon preparation auto-writes agent command mapping', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-prepare-warp-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = {
    HOME: root,
    TERM_PROGRAM: 'WarpTerminal',
    WARP_IS_LOCAL_SHELL_SESSION: '1'
  };
  const writes = [];

  const result = prepareCurrentTerminalProviderIcon('codex', {
    fs,
    path,
    env,
    processImpl: {
      platform: 'darwin',
      env,
      stdout: {
        isTTY: true,
        write: (text) => writes.push(text)
      }
    }
  });
  const content = fs.readFileSync(resolveWarpSettingsPath({ path, platform: 'darwin', env }), 'utf8');

  assert.deepEqual(result, { applied: true, terminal: 'warp' });
  assert.equal(content.includes('"^aih\\\\s+codex(?:\\\\s|$).*" = "Codex"'), true);
  assert.equal(content.includes('"^aih\\\\s+claude(?:\\\\s|$).*" = "Claude"'), true);
  assert.equal(content.includes('"^aih\\\\s+gemini(?:\\\\s|$).*" = "Gemini"'), true);
  assert.equal(content.includes('"^aih\\\\s+opencode(?:\\\\s|$).*" = "OpenCode"'), true);
  assert.equal(content.includes('"^aih\\\\s+agy(?:\\\\s|$).*" = "Gemini"'), true);
  assert.deepEqual(writes, []);
  assert.equal(env.AIH_WARP_PROVIDER_ICON, 'codex');
});

test('terminal icon command auto-installs Warp mappings when Warp is detected', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-install-warp-auto-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const logs = [];
  const errors = [];
  const code = runTerminalIconCommand('claude', ['--install'], {
    fs,
    path,
    consoleImpl: {
      log: (line) => logs.push(String(line)),
      error: (line) => errors.push(String(line))
    },
    processImpl: {
      platform: 'darwin',
      env: {
        HOME: root,
        TERM_PROGRAM: 'WarpTerminal'
      }
    }
  });
  const settingsPath = path.join(root, '.warp', 'settings.toml');
  const content = fs.readFileSync(settingsPath, 'utf8');

  assert.equal(code, 0);
  assert.deepEqual(errors, []);
  assert.equal(logs.some((line) => line.includes('Warp CLI-agent command mappings written')), true);
  assert.equal(content.includes('"^aih\\\\s+claude(?:\\\\s|$).*" = "Claude"'), true);
  assert.equal(content.includes('"^aih\\\\s+gemini(?:\\\\s|$).*" = "Gemini"'), true);
});

test('terminal icon command prints provider icon path by default', () => {
  const logs = [];
  const errors = [];
  const code = runTerminalIconCommand('claude', [], {
    consoleImpl: {
      log: (line) => logs.push(String(line)),
      error: (line) => errors.push(String(line))
    },
    processImpl: { env: {} }
  });

  assert.equal(code, 0);
  assert.equal(errors.length, 0);
  assert.equal(logs.some((line) => line.includes('Claude:')), true);
  assert.equal(logs.some((line) => line.includes(path.join('assets', 'provider-icons', 'claude.png'))), true);
});

test('terminal icon command installs all provider profiles when explicit', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-terminal-icons-install-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const logs = [];
  const errors = [];
  const code = runTerminalIconCommand('codex', ['--all', '--install-windows-terminal'], {
    fs,
    path,
    consoleImpl: {
      log: (line) => logs.push(String(line)),
      error: (line) => errors.push(String(line))
    },
    processImpl: { env: { LOCALAPPDATA: root } },
    repoRoot: '/repo'
  });
  const target = path.join(root, 'Microsoft', 'Windows Terminal', 'Fragments', 'AI Home', 'provider-icons.json');
  const written = JSON.parse(fs.readFileSync(target, 'utf8'));

  assert.equal(code, 0);
  assert.equal(errors.length, 0);
  assert.equal(logs.some((line) => line.includes('provider icon profiles written')), true);
  assert.equal(written.profiles.some((profile) => profile.name === 'AIH Claude'), true);
  assert.equal(written.profiles.some((profile) => profile.icon.endsWith(path.join('assets', 'provider-icons', 'claude.png'))), true);
});
