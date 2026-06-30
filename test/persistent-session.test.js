const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const persistentSession = require('../lib/runtime/persistent-session');

test('deriveSocket is stable and per-account (independent isolated server)', () => {
  assert.equal(persistentSession.deriveSocket('claude', '1'), 'aih-claude-1');
  assert.equal(persistentSession.deriveSocket('claude', '1'), 'aih-claude-1');
  assert.notEqual(
    persistentSession.deriveSocket('claude', '1'),
    persistentSession.deriveSocket('claude', '2')
  );
  assert.equal(persistentSession.deriveSocket('co dex', 'a/b:c'), 'aih-co-dex-a-b-c');
});

test('deriveSessionName: per-project by default, per-label when named', () => {
  // Same cwd => same session (auto re-attach). Different cwd => different session.
  const a = persistentSession.deriveSessionName({ cwd: '/work/alpha' });
  const a2 = persistentSession.deriveSessionName({ cwd: '/work/alpha' });
  const b = persistentSession.deriveSessionName({ cwd: '/work/beta' });
  assert.equal(a, a2);
  assert.notEqual(a, b);
  assert.match(a, /^p-alpha-[a-z0-9]{6}$/);
  // Same basename, different path => disambiguated by hash (no collision).
  const c = persistentSession.deriveSessionName({ cwd: '/other/alpha' });
  assert.notEqual(a, c);
  // Explicit label => a named window, independent of cwd.
  assert.equal(persistentSession.deriveSessionName({ cwd: '/work/alpha', label: 'work2' }), 's-work2');
  assert.equal(persistentSession.deriveSessionName({ label: 'work2' }), 's-work2');
});

test('deriveFallbackParallelSessionName appends a unique safe suffix', () => {
  assert.equal(
    persistentSession.deriveFallbackParallelSessionName('p-alpha-abc123', { now: 36, pid: 72 }),
    'p-alpha-abc123-10-20'
  );
  assert.equal(
    persistentSession.deriveFallbackParallelSessionName('bad name/with spaces', { now: 36 }),
    'bad-name-with-spaces-10'
  );
});

test('detectTmux: disable flag wins on every platform', () => {
  persistentSession._resetDetectCacheForTests();
  const disabled = persistentSession.detectTmux({
    platform: 'linux',
    env: { AIH_NO_PERSIST: '1' },
    resolveCommandPath: () => '/usr/bin/tmux'
  });
  assert.equal(disabled.available, false);
  assert.equal(disabled.reason, 'disabled');
});

test('detectTmux: POSIX resolves tmux on PATH or via spawn probe', () => {
  persistentSession._resetDetectCacheForTests();
  const resolved = persistentSession.detectTmux({
    platform: 'darwin',
    env: {},
    resolveCommandPath: () => '/opt/homebrew/bin/tmux'
  });
  assert.equal(resolved.available, true);
  assert.equal(resolved.command, '/opt/homebrew/bin/tmux');

  const viaSpawn = persistentSession.detectTmux({
    platform: 'linux',
    env: {},
    spawnSync: () => ({ status: 0 })
  });
  assert.equal(viaSpawn.available, true);
  assert.equal(viaSpawn.command, 'tmux');

  const missing = persistentSession.detectTmux({ platform: 'linux', env: {}, resolveCommandPath: () => '' });
  assert.equal(missing.available, false);
  assert.equal(missing.reason, 'not-found');
});

test('detectTmux: Windows finds psmux / PATH tmux / MSYS2 location', () => {
  persistentSession._resetDetectCacheForTests();
  // psmux on PATH (preferred native ConPTY engine).
  const psmux = persistentSession.detectTmux({
    platform: 'win32',
    env: {},
    resolveCommandPath: (name) => (name === 'psmux' ? 'C:\\tools\\psmux.exe' : '')
  });
  assert.equal(psmux.available, true);
  assert.equal(psmux.command, 'C:\\tools\\psmux.exe');

  // Falls back to an MSYS2 tmux.exe discovered on disk.
  const msys = persistentSession.detectTmux({
    platform: 'win32',
    env: {},
    resolveCommandPath: () => '',
    existsSync: (p) => p === 'C:\\msys64\\usr\\bin\\tmux.exe'
  });
  assert.equal(msys.available, true);
  assert.equal(msys.command, 'C:\\msys64\\usr\\bin\\tmux.exe');

  // Nothing present => clear remediation, not a crash.
  const none = persistentSession.detectTmux({
    platform: 'win32',
    env: {},
    resolveCommandPath: () => '',
    existsSync: () => false
  });
  assert.equal(none.available, false);
  assert.equal(none.reason, 'windows-no-tmux');
  assert.match(none.remediation, /psmux/);
});

test('detectTmux: Windows default resolver finds psmux.exe from PATH', (t) => {
  persistentSession._resetDetectCacheForTests();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-psmux-path-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const psmuxPath = path.join(root, 'psmux.exe');
  fs.writeFileSync(psmuxPath, 'fake psmux\n', 'utf8');

  const found = persistentSession.detectTmux({
    platform: 'win32',
    env: {
      Path: root,
      PATHEXT: '.EXE;.CMD;.BAT'
    },
    spawnSync: () => {
      throw new Error('where.exe should not be needed when PATH scan resolves psmux.exe');
    }
  });

  assert.equal(found.available, true);
  assert.equal(found.command, psmuxPath);
});

test('detectTmux: Windows finds psmux in WinGet Links even when PATH is stale', () => {
  persistentSession._resetDetectCacheForTests();
  const psmuxPath = 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Links\\psmux.exe';
  const found = persistentSession.detectTmux({
    platform: 'win32',
    env: {
      LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
      Path: ''
    },
    resolveCommandPath: () => '',
    existsSync: (candidate) => candidate === psmuxPath
  });

  assert.equal(found.available, true);
  assert.equal(found.command, psmuxPath);
});

test('installWindowsPsmux runs the exact winget package and reports status', () => {
  const calls = [];
  const result = persistentSession.installWindowsPsmux({
    spawnSync: (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0 };
    },
    stdio: 'inherit'
  });
  const install = persistentSession.buildWindowsPsmuxInstallCommand();

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [{
    command: 'winget',
    args: install.args,
    options: { stdio: 'inherit' }
  }]);
  assert.equal(install.args.includes(persistentSession.PSMUX_WINGET_PACKAGE_ID), true);
});

test('shouldPersist gates on tmux, login, TTY, marker and disable flag', () => {
  const tmux = { available: true, command: 'tmux' };
  assert.equal(persistentSession.shouldPersist({ tmux, isLogin: false, isTTY: true, env: {} }), true);
  assert.equal(persistentSession.shouldPersist({ tmux: { available: false }, isTTY: true, env: {} }), false);
  assert.equal(persistentSession.shouldPersist({ tmux, isLogin: true, isTTY: true, env: {} }), false);
  assert.equal(persistentSession.shouldPersist({ tmux, isLogin: false, isTTY: false, env: {} }), false);
  assert.equal(persistentSession.shouldPersist({ tmux, isTTY: true, env: { AIH_PERSIST_ACTIVE: '1' } }), false);
  assert.equal(persistentSession.shouldPersist({ tmux, isTTY: true, env: { AIH_NO_PERSIST: '1' } }), false);
});

test('buildTmuxLaunch: attach-or-create, project session, secrets out of argv', () => {
  const wrapped = persistentSession.buildTmuxLaunch(
    { command: '/usr/local/bin/claude', args: ['--model', 'opus'] },
    {
      cliName: 'claude',
      id: '2',
      cwd: '/work/project',
      tmuxCommand: '/usr/bin/tmux',
      confPath: '/home/u/.aih/persist/tmux.conf'
    }
  );
  assert.equal(wrapped.command, '/usr/bin/tmux');
  assert.equal(wrapped.socket, 'aih-claude-2');
  assert.match(wrapped.session, /^p-project-[a-z0-9]{6}$/);
  assert.deepEqual(wrapped.args, [
    '-u', '-L', 'aih-claude-2',
    '-f', '/home/u/.aih/persist/tmux.conf',
    'new-session', '-A', '-D',
    '-e', `${persistentSession.UTF8_RUNTIME_MARKER_KEY}=${persistentSession.UTF8_RUNTIME_MARKER_VALUE}`,
    '-s', wrapped.session,
    '-c', '/work/project',
    '--', '/usr/local/bin/claude', '--model', 'opus'
  ]);
});

test('buildTmuxLaunch: explicit label yields a named concurrent window', () => {
  const wrapped = persistentSession.buildTmuxLaunch(
    { command: 'codex', args: [] },
    { cliName: 'codex', id: '1', cwd: '/work/project', label: 'work2', tmuxCommand: 'tmux' }
  );
  assert.equal(wrapped.session, 's-work2');
  assert.deepEqual(wrapped.args, [
    '-u', '-L', 'aih-codex-1',
    'new-session', '-A', '-D',
    '-e', `${persistentSession.UTF8_RUNTIME_MARKER_KEY}=${persistentSession.UTF8_RUNTIME_MARKER_VALUE}`,
    '-s', 's-work2',
    '-c', '/work/project',
    '--', 'codex'
  ]);
});

test('buildTmuxLaunch: passes safe runtime env through tmux session env only', () => {
  const wrapped = persistentSession.buildTmuxLaunch(
    { command: 'codex', args: [], env: { OPENAI_API_KEY: 'sk-secret' } },
    {
      cliName: 'codex',
      id: '1',
      cwd: '/work/project',
      tmuxCommand: 'tmux',
      env: {
        LANG: 'C.UTF-8',
        LC_CTYPE: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
        CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT: '1',
        CLAUDE_CODE_DISABLE_VIRTUAL_SCROLL: '1',
        [persistentSession.CLAUDE_RENDER_RUNTIME_MARKER_KEY]: persistentSession.CLAUDE_RENDER_RUNTIME_MARKER_VALUE,
        OPENAI_API_KEY: 'sk-secret'
      }
    }
  );

  assert.deepEqual(wrapped.args.slice(3, 21), [
    'new-session',
    '-A',
    '-D',
    '-e',
    'LANG=C.UTF-8',
    '-e',
    'LC_CTYPE=C.UTF-8',
    '-e',
    'LC_ALL=C.UTF-8',
    '-e',
    'CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT=1',
    '-e',
    'CLAUDE_CODE_DISABLE_VIRTUAL_SCROLL=1',
    '-e',
    `${persistentSession.CLAUDE_RENDER_RUNTIME_MARKER_KEY}=${persistentSession.CLAUDE_RENDER_RUNTIME_MARKER_VALUE}`,
    '-e',
    `${persistentSession.UTF8_RUNTIME_MARKER_KEY}=${persistentSession.UTF8_RUNTIME_MARKER_VALUE}`,
    '-s'
  ]);
  assert.equal(wrapped.args.includes('OPENAI_API_KEY=sk-secret'), false);
});

test('buildSetEnvironmentCommands syncs only safe tmux env keys', () => {
  const commands = persistentSession.buildSetEnvironmentCommands({
    cliName: 'claude',
    id: '2',
    tmuxCommand: '/usr/bin/tmux',
    env: {
      LANG: 'en_US.UTF-8',
      LC_CTYPE: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
      CLAUDE_CODE_FORCE_SYNC_OUTPUT: '1',
      CLAUDE_CODE_DISABLE_VIRTUAL_SCROLL: '1',
      [persistentSession.CLAUDE_RENDER_RUNTIME_MARKER_KEY]: persistentSession.CLAUDE_RENDER_RUNTIME_MARKER_VALUE,
      ANTHROPIC_API_KEY: 'sk-secret'
    }
  });

  assert.deepEqual(commands.map((cmd) => cmd.args), [
    ['-u', '-L', 'aih-claude-2', 'set-environment', '-g', 'LANG', 'en_US.UTF-8'],
    ['-u', '-L', 'aih-claude-2', 'set-environment', '-g', 'LC_CTYPE', 'en_US.UTF-8'],
    ['-u', '-L', 'aih-claude-2', 'set-environment', '-g', 'LC_ALL', 'en_US.UTF-8'],
    ['-u', '-L', 'aih-claude-2', 'set-environment', '-g', 'CLAUDE_CODE_FORCE_SYNC_OUTPUT', '1'],
    ['-u', '-L', 'aih-claude-2', 'set-environment', '-g', 'CLAUDE_CODE_DISABLE_VIRTUAL_SCROLL', '1'],
    [
      '-u',
      '-L',
      'aih-claude-2',
      'set-environment',
      '-g',
      persistentSession.CLAUDE_RENDER_RUNTIME_MARKER_KEY,
      persistentSession.CLAUDE_RENDER_RUNTIME_MARKER_VALUE
    ]
  ]);
  assert.equal(commands.some((cmd) => cmd.args.includes('sk-secret')), false);
});

test('buildSetEnvironmentCommands can target one existing session', () => {
  const commands = persistentSession.buildSetEnvironmentCommands({
    cliName: 'codex',
    id: '1',
    sessionName: 'p-picked',
    env: {
      LANG: 'C.UTF-8',
      LC_CTYPE: 'C.UTF-8',
      LC_ALL: 'C.UTF-8'
    }
  });

  assert.deepEqual(commands[0].args, [
    '-u',
    '-L',
    'aih-codex-1',
    'set-environment',
    '-t',
    'p-picked',
    'LANG',
    'C.UTF-8'
  ]);
  assert.equal(commands.every((cmd) => cmd.session === 'p-picked'), true);
});

test('buildListSessionsCommand targets the account socket', () => {
  const cmd = persistentSession.buildListSessionsCommand({ cliName: 'claude', id: '3', tmuxCommand: 'tmux' });
  const sep = persistentSession.SESSION_LIST_SEPARATOR;
  assert.equal(cmd.socket, 'aih-claude-3');
  assert.deepEqual(cmd.args, [
    '-u',
    '-L', 'aih-claude-3',
    'list-sessions',
    '-F', [
      '#{session_name}',
      '#{session_attached}',
      '#{session_created}',
      '#{session_path}',
      '#{pane_title}',
      '#{window_name}',
      '#{pane_current_command}',
      '#{pane_pid}',
      `#{E:${persistentSession.UTF8_RUNTIME_MARKER_KEY}}`,
      `#{E:${persistentSession.CLAUDE_RENDER_RUNTIME_MARKER_KEY}}`,
      '#{pane_dead}',
      `#{E:${persistentSession.PSMUX_CODEX_LAUNCH_RUNTIME_MARKER_KEY}}`
    ].join(sep)
  ]);
});

test('isNativeWindowsPsmuxCommand identifies only native Windows psmux binaries', () => {
  assert.equal(persistentSession.isNativeWindowsPsmuxCommand('psmux', 'win32'), true);
  assert.equal(persistentSession.isNativeWindowsPsmuxCommand('C:\\tools\\psmux.exe', 'win32'), true);
  assert.equal(persistentSession.isNativeWindowsPsmuxCommand('C:/tools/psmux.exe', 'win32'), true);
  assert.equal(persistentSession.isNativeWindowsPsmuxCommand('tmux.exe', 'win32'), false);
  assert.equal(persistentSession.isNativeWindowsPsmuxCommand('/usr/bin/psmux', 'linux'), false);
});

test('buildTmuxLaunch can use explicit psmux attach after a trusted existing-session plan', () => {
  const explicitPsmuxAttachedLaunch = persistentSession.buildTmuxLaunch(
    { command: 'codex', args: [] },
    {
      cliName: 'codex',
      id: '1',
      sessionName: 'p-ai-home-abc123',
      tmuxCommand: 'C:\\tools\\psmux.exe',
      confPath: 'C:\\aih\\persist\\tmux.conf',
      explicitAttach: true,
      attachExisting: true,
      detachOnAttach: false
    }
  );

  assert.deepEqual(explicitPsmuxAttachedLaunch.args, [
    '-u',
    '-L',
    'aih-codex-1',
    '-f',
    'C:\\aih\\persist\\tmux.conf',
    'attach-session',
    '-t',
    'p-ai-home-abc123'
  ]);
  assert.equal(explicitPsmuxAttachedLaunch.args.includes('codex'), false);

  const explicitPsmuxCreateLaunch = persistentSession.buildTmuxLaunch(
    { command: 'codex', args: ['--ask-for-approval'] },
    {
      cliName: 'codex',
      id: '1',
      sessionName: 'p-ai-home-abc123-2',
      tmuxCommand: 'C:\\tools\\psmux.exe',
      explicitAttach: true
    }
  );

  assert.equal(explicitPsmuxCreateLaunch.args.includes('new-session'), true);
  assert.equal(explicitPsmuxCreateLaunch.args.includes('-A'), false);
  assert.equal(explicitPsmuxCreateLaunch.args.includes('-D'), false);
  assert.equal(explicitPsmuxCreateLaunch.args.includes('codex'), true);
  assert.equal(explicitPsmuxCreateLaunch.args.includes('--ask-for-approval'), true);
});

test('buildDetachClientCommand targets all clients attached to one safe session', () => {
  const cmd = persistentSession.buildDetachClientCommand({
    cliName: 'codex',
    id: '.aih-server',
    sessionName: 'p-ai-home-abc123',
    tmuxCommand: 'psmux'
  });

  assert.equal(cmd.socket, 'aih-codex-.aih-server');
  assert.equal(cmd.session, 'p-ai-home-abc123');
  assert.deepEqual(cmd.args, [
    '-u',
    '-L',
    'aih-codex-.aih-server',
    'detach-client',
    '-s',
    'p-ai-home-abc123'
  ]);
  assert.equal(
    persistentSession.buildDetachClientCommand({ cliName: 'codex', id: '1', sessionName: 'bad name' }),
    null
  );
});

test('buildCapturePaneCommand targets one safe account session', () => {
  const cmd = persistentSession.buildCapturePaneCommand({
    cliName: 'codex',
    id: '.aih-server',
    sessionName: 'p-ai-home-abc123',
    tmuxCommand: 'psmux',
    start: -40
  });

  assert.equal(cmd.socket, 'aih-codex-.aih-server');
  assert.equal(cmd.session, 'p-ai-home-abc123');
  assert.deepEqual(cmd.args, [
    '-u',
    '-L',
    'aih-codex-.aih-server',
    'capture-pane',
    '-p',
    '-t',
    'p-ai-home-abc123',
    '-S',
    '-40'
  ]);
  assert.equal(
    persistentSession.buildCapturePaneCommand({ cliName: 'codex', id: '1', sessionName: 'bad name' }),
    null
  );
});

test('buildKillSessionCommand targets one safe account session', () => {
  const cmd = persistentSession.buildKillSessionCommand({
    cliName: 'codex',
    id: '1',
    sessionName: 'p-ai-home-abc123',
    tmuxCommand: '/usr/bin/tmux'
  });

  assert.equal(cmd.socket, 'aih-codex-1');
  assert.equal(cmd.session, 'p-ai-home-abc123');
  assert.deepEqual(cmd.args, [
    '-u',
    '-L',
    'aih-codex-1',
    'kill-session',
    '-t',
    'p-ai-home-abc123'
  ]);
  assert.equal(
    persistentSession.buildKillSessionCommand({ cliName: 'codex', id: '1', sessionName: 'bad name' }),
    null
  );
});

test('buildKillServerCommand kills the whole tmux server for the account socket', () => {
  const cmd = persistentSession.buildKillServerCommand({
    cliName: 'codex',
    id: '1',
    tmuxCommand: '/usr/bin/tmux'
  });

  assert.equal(cmd.socket, 'aih-codex-1');
  assert.deepEqual(cmd.args, ['-u', '-L', 'aih-codex-1', 'kill-server']);
  assert.equal(cmd.command, '/usr/bin/tmux');
});

test('buildSourceConfigCommand targets the account socket config reload', () => {
  const cmd = persistentSession.buildSourceConfigCommand({
    cliName: 'codex',
    id: '1',
    tmuxCommand: 'tmux',
    confPath: '/home/u/.ai_home/persist/tmux.conf'
  });
  assert.equal(cmd.socket, 'aih-codex-1');
  assert.deepEqual(cmd.args, [
    '-u',
    '-L',
    'aih-codex-1',
    'source-file',
    '/home/u/.ai_home/persist/tmux.conf'
  ]);
  assert.equal(persistentSession.buildSourceConfigCommand({ cliName: 'codex', id: '1', confPath: '' }), null);
});

test('ensureTmuxConf writes the transparent config idempotently', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-persist-'));
  const confPath = path.join(dir, 'persist', 'tmux.conf');
  assert.equal(persistentSession.ensureTmuxConf(confPath, fs), confPath);
  const body = fs.readFileSync(confPath, 'utf8');
  assert.match(body, /set -g status off/);
  assert.match(body, /set -g window-size latest/);
  assert.match(body, /set -g mouse on/);
  assert.match(body, /set -gq allow-passthrough on/);
  assert.match(body, /set -g extended-keys on/);
  assert.doesNotMatch(body, /set -g extended-keys always/);
  assert.match(body, /set -g extended-keys-format csi-u/);
  assert.match(body, /set -g remain-on-exit off/);
  assert.match(body, /set -g terminal-features\[0\] "xterm\*:clipboard:ccolour:cstyle:focus:title:extkeys:sync"/);
  assert.match(body, /set -gqu terminal-features\[3\]/);
  assert.doesNotMatch(body, /set -as terminal-features/);
  // aggressive-resize must be explicitly OFF: under our multi-session /
  // multi-client (-M mirror) server it otherwise resizes the live window from
  // another session's activity and leaves stale glyphs in an interactive TUI.
  assert.match(body, /set -g aggressive-resize off/);
  assert.doesNotMatch(body, /set -g aggressive-resize on/);
  assert.equal(persistentSession.ensureTmuxConf(confPath, fs), confPath);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ensureTmuxConf writes a psmux-compatible transparent config on native Windows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-persist-psmux-'));
  const confPath = path.join(dir, 'persist', 'tmux.conf');

  assert.equal(persistentSession.ensureTmuxConf(confPath, fs, {
    platform: 'win32',
    tmuxCommand: 'C:\\tools\\psmux.exe'
  }), confPath);

  const body = fs.readFileSync(confPath, 'utf8');
  assert.match(body, /Keeps psmux invisible/);
  assert.match(body, /set -g status off/);
  assert.match(body, /set -g remain-on-exit off/);
  assert.match(body, /set -g destroy-unattached off/);
  assert.doesNotMatch(body, /extended-keys on/);
  assert.doesNotMatch(body, /extended-keys-format/);
  assert.doesNotMatch(body, /detach-on-destroy/);
  assert.equal(persistentSession.getTmuxConfContent({
    platform: 'win32',
    tmuxCommand: 'psmux'
  }), persistentSession.PSMUX_TRANSPARENT_CONF);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('parseSessionList parses name + attached state + path', () => {
  assert.deepEqual(
    persistentSession.parseSessionList('p-x\t1\t100\t/home/me/a\np-y\t0\t200\t/home/me/b\n\n'),
    [
      {
        name: 'p-x',
        attached: true,
        created: 100,
        path: '/home/me/a',
        title: '',
        windowName: '',
        command: '',
        panePid: 0,
        utf8Runtime: '',
        utf8RuntimeChecked: false,
        utf8RuntimeReady: false,
        claudeRenderRuntime: '',
        claudeRenderRuntimeChecked: false,
        claudeRenderRuntimeReady: false,
        paneDead: false,
        paneDeadChecked: false,
        psmuxCodexLaunchRuntime: '',
        psmuxCodexLaunchRuntimeChecked: false,
        psmuxCodexLaunchRuntimeReady: false
      },
      {
        name: 'p-y',
        attached: false,
        created: 200,
        path: '/home/me/b',
        title: '',
        windowName: '',
        command: '',
        panePid: 0,
        utf8Runtime: '',
        utf8RuntimeChecked: false,
        utf8RuntimeReady: false,
        claudeRenderRuntime: '',
        claudeRenderRuntimeChecked: false,
        claudeRenderRuntimeReady: false,
        paneDead: false,
        paneDeadChecked: false,
        psmuxCodexLaunchRuntime: '',
        psmuxCodexLaunchRuntimeChecked: false,
        psmuxCodexLaunchRuntimeReady: false
      }
    ]
  );
  assert.deepEqual(persistentSession.parseSessionList(''), []);
});

test('parseSessionList carries pane dead state from tmux format', () => {
  const sep = persistentSession.SESSION_LIST_SEPARATOR;
  const [dead, live] = persistentSession.parseSessionList([
    [
      'p-dead',
      '0',
      '100',
      '/work/dead',
      'session completed',
      'codex',
      'node',
      '123',
      persistentSession.UTF8_RUNTIME_MARKER_VALUE,
      '',
      '1'
    ].join(sep),
    [
      'p-live',
      '0',
      '100',
      '/work/live',
      'live task',
      'codex',
      'node',
      '124',
      persistentSession.UTF8_RUNTIME_MARKER_VALUE,
      '',
      '0'
    ].join(sep)
  ].join('\n'));

  assert.equal(dead.paneDeadChecked, true);
  assert.equal(dead.paneDead, true);
  assert.equal(live.paneDeadChecked, true);
  assert.equal(live.paneDead, false);
});

test('isCompletedSessionScreen detects only explicit completed terminal screens', () => {
  assert.equal(persistentSession.isCompletedSessionScreen('\x1b[2KSession completed\r\n'), true);
  assert.equal(persistentSession.isCompletedSessionScreen('session    completed'), true);
  assert.equal(persistentSession.isCompletedSessionScreen('Import completed successfully'), false);
  assert.equal(persistentSession.isCompletedSessionScreen('Working (1m 01s - esc to interrupt)'), false);
});

test('parseSessionList carries UTF-8 runtime marker from tmux format', () => {
  const sep = persistentSession.SESSION_LIST_SEPARATOR;
  const [ready, legacy] = persistentSession.parseSessionList([
    [
      'p-ready',
      '0',
      '100',
      '/work/ready',
      '',
      'codex',
      'node',
      '123',
      persistentSession.UTF8_RUNTIME_MARKER_VALUE
    ].join(sep),
    [
      'p-legacy',
      '0',
      '100',
      '/work/legacy',
      '',
      'codex',
      'node',
      '124',
      ''
    ].join(sep)
  ].join('\n'));

  assert.equal(ready.utf8RuntimeChecked, true);
  assert.equal(ready.utf8RuntimeReady, true);
  assert.equal(persistentSession.isUtf8RuntimeReadySession(ready), true);
  assert.equal(legacy.utf8RuntimeChecked, true);
  assert.equal(legacy.utf8RuntimeReady, false);
});

test('parseSessionList carries Claude render runtime marker from tmux format', () => {
  const sep = persistentSession.SESSION_LIST_SEPARATOR;
  const [ready, legacy] = persistentSession.parseSessionList([
    [
      'p-ready',
      '0',
      '100',
      '/work/ready',
      '',
      'claude',
      'claude',
      '123',
      persistentSession.UTF8_RUNTIME_MARKER_VALUE,
      persistentSession.CLAUDE_RENDER_RUNTIME_MARKER_VALUE
    ].join(sep),
    [
      'p-legacy',
      '0',
      '100',
      '/work/legacy',
      '',
      'claude',
      'claude',
      '124',
      persistentSession.UTF8_RUNTIME_MARKER_VALUE,
      ''
    ].join(sep)
  ].join('\n'));

  assert.equal(ready.claudeRenderRuntimeChecked, true);
  assert.equal(ready.claudeRenderRuntimeReady, true);
  assert.equal(persistentSession.isClaudeRenderRuntimeReadySession(ready), true);
  assert.equal(legacy.claudeRenderRuntimeChecked, true);
  assert.equal(legacy.claudeRenderRuntimeReady, false);
});

test('parseSessionList carries psmux Codex launch runtime marker from tmux format', () => {
  const sep = persistentSession.SESSION_LIST_SEPARATOR;
  const [ready, legacy] = persistentSession.parseSessionList([
    [
      'p-ready',
      '0',
      '100',
      '/work/ready',
      '',
      'codex',
      'node',
      '123',
      persistentSession.UTF8_RUNTIME_MARKER_VALUE,
      '',
      '0',
      persistentSession.PSMUX_CODEX_LAUNCH_RUNTIME_MARKER_VALUE
    ].join(sep),
    [
      'p-legacy',
      '0',
      '100',
      '/work/legacy',
      '',
      'codex',
      'node',
      '124',
      persistentSession.UTF8_RUNTIME_MARKER_VALUE,
      '',
      '0',
      ''
    ].join(sep)
  ].join('\n'));

  assert.equal(ready.psmuxCodexLaunchRuntimeChecked, true);
  assert.equal(ready.psmuxCodexLaunchRuntimeReady, true);
  assert.equal(persistentSession.isPsmuxCodexLaunchRuntimeReadySession(ready), true);
  assert.equal(legacy.psmuxCodexLaunchRuntimeChecked, true);
  assert.equal(legacy.psmuxCodexLaunchRuntimeReady, false);
});

test('parseSessionList carries pane title fields for session descriptions', () => {
  const sep = persistentSession.SESSION_LIST_SEPARATOR;
  const [session] = persistentSession.parseSessionList([
    'p-work-abc123',
    '1',
    '100',
    '/home/me/work',
    '实现 tmux sessions 选择器',
    'codex',
    'node',
    '12345'
  ].join(sep));

  assert.equal(session.title, '实现 tmux sessions 选择器');
  assert.equal(session.panePid, 12345);
  assert.equal(
    persistentSession.deriveSessionDescription({
      title: '[o:1:91%]',
      windowName: '修复滚动焦点',
      command: 'codex'
    }),
    '修复滚动焦点'
  );
});

test('deriveSessionDescription prefers agent title and ignores spinner terminal title', () => {
  assert.equal(
    persistentSession.deriveSessionDescription({
      agentTitle: '修复 sessions 选择器',
      title: '⠴ ai_home',
      windowName: 'node',
      command: 'node',
      path: '/Users/model/projects/feature/ai_home'
    }),
    '修复 sessions 选择器'
  );
  assert.equal(
    persistentSession.deriveSessionDescription({
      title: '⠴ ai_home',
      windowName: 'node',
      command: 'node',
      path: '/Users/model/projects/feature/ai_home'
    }),
    'ai_home'
  );
});

test('planPersistentSession never steals a live local session (opens a parallel one)', () => {
  const base = 'p-proj-ab12cd34';
  const plan = (sessions, hasLabel = false) => persistentSession.planPersistentSession(sessions, base, { hasLabel });

  // No session yet -> create it.
  assert.deepEqual(plan([]), { session: base, action: 'new' });
  // Previous client gone (closed terminal / dropped SSH) -> reconnect into it.
  assert.deepEqual(plan([{ name: base, attached: false }]), { session: base, action: 'reattach' });
  // Second window, same project, while the first is LIVE -> parallel, NOT a steal.
  assert.deepEqual(plan([{ name: base, attached: true }]), { session: `${base}-2`, action: 'new-parallel' });
  // A free parallel sibling is reused instead of spawning yet another.
  assert.deepEqual(
    plan([{ name: base, attached: true }, { name: `${base}-2`, attached: false }]),
    { session: `${base}-2`, action: 'reattach' }
  );
  // All parallels live -> next free index.
  assert.deepEqual(
    plan([{ name: base, attached: true }, { name: `${base}-2`, attached: true }]),
    { session: `${base}-3`, action: 'new-parallel' }
  );
});

test('planPersistentSession opens a fresh compatible session for legacy UTF-8 runtime', () => {
  const base = 'p-proj-ab12cd34';
  const ready = {
    name: `${base}-2`,
    attached: false,
    utf8RuntimeChecked: true,
    utf8Runtime: persistentSession.UTF8_RUNTIME_MARKER_VALUE
  };

  assert.deepEqual(
    persistentSession.planPersistentSession(
      [{ name: base, attached: false, utf8RuntimeChecked: true, utf8Runtime: '' }],
      base,
      { requireUtf8Runtime: true }
    ),
    { session: `${base}-2`, action: 'new-compatible' }
  );
  assert.deepEqual(
    persistentSession.planPersistentSession(
      [{ name: base, attached: true, utf8RuntimeChecked: true, utf8Runtime: '' }, ready],
      base,
      { requireUtf8Runtime: true }
    ),
    { session: `${base}-2`, action: 'reattach' }
  );
  assert.deepEqual(
    persistentSession.planPersistentSession(
      [{ name: base, attached: false }],
      base,
      { requireUtf8Runtime: true }
    ),
    { session: base, action: 'reattach' }
  );
});

test('planPersistentSession opens a fresh compatible session for legacy Claude render runtime', () => {
  const base = 'p-proj-ab12cd34';
  const ready = {
    name: `${base}-2`,
    attached: false,
    claudeRenderRuntimeChecked: true,
    claudeRenderRuntime: persistentSession.CLAUDE_RENDER_RUNTIME_MARKER_VALUE
  };

  assert.deepEqual(
    persistentSession.planPersistentSession(
      [{ name: base, attached: false, claudeRenderRuntimeChecked: true, claudeRenderRuntime: '' }],
      base,
      { requireClaudeRenderRuntime: true }
    ),
    { session: `${base}-2`, action: 'new-compatible' }
  );
  assert.deepEqual(
    persistentSession.planPersistentSession(
      [{ name: base, attached: true, claudeRenderRuntimeChecked: true, claudeRenderRuntime: '' }, ready],
      base,
      { requireClaudeRenderRuntime: true }
    ),
    { session: `${base}-2`, action: 'reattach' }
  );
});

test('planPersistentSession opens a fresh compatible session for legacy psmux Codex launch runtime', () => {
  const base = 'p-proj-ab12cd34';
  const ready = {
    name: `${base}-2`,
    attached: false,
    psmuxCodexLaunchRuntimeChecked: true,
    psmuxCodexLaunchRuntime: persistentSession.PSMUX_CODEX_LAUNCH_RUNTIME_MARKER_VALUE
  };

  assert.deepEqual(
    persistentSession.planPersistentSession(
      [{ name: base, attached: false, psmuxCodexLaunchRuntimeChecked: true, psmuxCodexLaunchRuntime: '2026-07-no-cmd-shim' }],
      base,
      { requirePsmuxCodexLaunchRuntime: true }
    ),
    { session: `${base}-2`, action: 'new-compatible' }
  );
  assert.deepEqual(
    persistentSession.planPersistentSession(
      [{ name: base, attached: true, psmuxCodexLaunchRuntimeChecked: true, psmuxCodexLaunchRuntime: '' }, ready],
      base,
      { requirePsmuxCodexLaunchRuntime: true }
    ),
    { session: `${base}-2`, action: 'reattach' }
  );
});

test('planPersistentSession opens a fresh session for completed dead panes', () => {
  const base = 'p-proj-ab12cd34';
  const ready = {
    name: `${base}-2`,
    attached: false,
    paneDeadChecked: true,
    paneDead: false
  };

  assert.deepEqual(
    persistentSession.planPersistentSession(
      [{ name: base, attached: false, paneDeadChecked: true, paneDead: true }],
      base,
      {}
    ),
    { session: `${base}-2`, action: 'new-completed' }
  );
  assert.deepEqual(
    persistentSession.planPersistentSession(
      [{ name: base, attached: true, paneDeadChecked: true, paneDead: true }, ready],
      base,
      { hasLabel: true }
    ),
    { session: `${base}-2`, action: 'reattach' }
  );
});

test('planPersistentSession opens a fresh session for completed terminal screens', () => {
  const base = 'p-proj-ab12cd34';
  assert.deepEqual(
    persistentSession.planPersistentSession(
      [{ name: base, attached: true, screenCompletedChecked: true, screenCompleted: true }],
      base,
      { hasLabel: true }
    ),
    { session: `${base}-2`, action: 'new-completed' }
  );
});

test('planPersistentSession honors an explicit -S label (takeover when live)', () => {
  const named = 's-debug';
  const plan = (sessions) => persistentSession.planPersistentSession(sessions, named, { hasLabel: true });
  assert.deepEqual(plan([]), { session: named, action: 'new' });
  assert.deepEqual(plan([{ name: named, attached: false }]), { session: named, action: 'reattach' });
  // Named target that is live elsewhere: the user asked for THAT session by name,
  // so take it over (detach the other client) rather than spawning a parallel.
  assert.deepEqual(plan([{ name: named, attached: true }]), { session: named, action: 'takeover' });
});

test('describeSessionList groups this-project vs others with runnable commands', () => {
  const cwd = '/home/me/projA';
  const base = persistentSession.deriveSessionName({ cwd });
  const sessions = [
    { name: base, attached: true, path: cwd },                  // this project, live
    { name: `${base}-2`, attached: false, path: cwd },          // this project parallel, idle
    { name: 's-debug', attached: false, path: cwd },            // named, started here
    { name: persistentSession.deriveSessionName({ cwd: '/home/me/projB' }), attached: false, path: '/home/me/projB' }
  ];
  const v = persistentSession.describeSessionList(sessions, { cliName: 'claude', id: '4', cwd });
  assert.equal(v.hasCwd, true);
  // this-project rows
  assert.deepEqual(v.here.map((r) => r.command), [
    'aih claude 4 -M',        // live default -> mirror without kicking
    'aih claude 4',           // idle parallel -> bare command reattaches
    'aih claude 4 -M -S debug' // named -> mirror by label
  ]);
  assert.equal(v.here[0].live, true);
  // other-project row carries a cd into its real path
  assert.deepEqual(v.others.map((r) => r.command), ['cd "/home/me/projB" && aih claude 4']);
});

test('describeSessionList recommends takeover commands when shared attach is unavailable', () => {
  const noShareProjectCwd = '/home/me/projA';
  const noShareBaseSession = persistentSession.deriveSessionName({ cwd: noShareProjectCwd });
  const noShareSessionRows = [
    { name: noShareBaseSession, attached: true, path: noShareProjectCwd },
    { name: 's-debug', attached: true, path: noShareProjectCwd },
    { name: persistentSession.deriveSessionName({ cwd: '/home/me/projB' }), attached: true, path: '/home/me/projB' }
  ];

  const noShareView = persistentSession.describeSessionList(noShareSessionRows, {
    cliName: 'codex',
    id: '1',
    cwd: noShareProjectCwd,
    shareLive: false
  });

  assert.deepEqual(noShareView.here.map((row) => row.command), [
    'aih codex 1 -R',
    'aih codex 1 -R -S debug'
  ]);
  assert.deepEqual(noShareView.others.map((row) => row.command), ['cd "/home/me/projB" && aih codex 1 -R']);
});

test('describeSessionList recommends compatible launch commands for legacy UTF-8 runtime rows', () => {
  const cwd = '/home/me/projA';
  const base = persistentSession.deriveSessionName({ cwd });
  const otherCwd = '/home/me/projB';
  const sessions = [
    { name: base, attached: true, path: cwd, utf8RuntimeChecked: true, utf8Runtime: '' },
    { name: 's-debug', attached: true, path: cwd, utf8RuntimeChecked: true, utf8Runtime: '' },
    {
      name: persistentSession.deriveSessionName({ cwd: otherCwd }),
      attached: true,
      path: otherCwd,
      utf8RuntimeChecked: true,
      utf8Runtime: ''
    }
  ];

  const v = persistentSession.describeSessionList(sessions, { cliName: 'codex', id: '1', cwd });

  assert.deepEqual(v.here.map((r) => r.command), [
    'aih codex 1',
    'aih codex 1'
  ]);
  assert.deepEqual(v.others.map((r) => r.command), ['cd "/home/me/projB" && aih codex 1']);
});

test('describeSessionList recommends fresh launches for legacy psmux Codex launch runtime rows', () => {
  const cwd = '/home/me/projA';
  const base = persistentSession.deriveSessionName({ cwd });
  const v = persistentSession.describeSessionList([
    {
      name: base,
      attached: true,
      path: cwd,
      psmuxCodexLaunchRuntimeChecked: true,
      psmuxCodexLaunchRuntime: ''
    }
  ], { cliName: 'codex', id: '1', cwd, shareLive: false });

  assert.deepEqual(v.here.map((r) => r.command), ['aih codex 1']);
  assert.deepEqual(v.here.map((r) => r.live), [true]);
});

test('describeSessionList recommends fresh launches for completed dead panes', () => {
  const cwd = '/home/me/projA';
  const base = persistentSession.deriveSessionName({ cwd });
  const otherCwd = '/home/me/projB';
  const sessions = [
    { name: base, attached: true, path: cwd, paneDeadChecked: true, paneDead: true },
    { name: 's-debug', attached: true, path: cwd, paneDeadChecked: true, paneDead: true },
    {
      name: persistentSession.deriveSessionName({ cwd: otherCwd }),
      attached: true,
      path: otherCwd,
      paneDeadChecked: true,
      paneDead: true
    }
  ];

  const v = persistentSession.describeSessionList(sessions, { cliName: 'codex', id: '1', cwd });

  assert.deepEqual(v.here.map((r) => r.command), [
    'aih codex 1',
    'aih codex 1'
  ]);
  assert.deepEqual(v.here.map((r) => r.live), [false, false]);
  assert.deepEqual(v.here.map((r) => r.completed), [true, true]);
  assert.deepEqual(v.others.map((r) => r.command), ['cd "/home/me/projB" && aih codex 1']);
});

test('describeSessionList recommends fresh launches for completed terminal screens', () => {
  const cwd = '/home/me/projA';
  const base = persistentSession.deriveSessionName({ cwd });
  const v = persistentSession.describeSessionList([
    { name: base, attached: true, path: cwd, screenCompletedChecked: true, screenCompleted: true }
  ], { cliName: 'codex', id: '1', cwd });

  assert.deepEqual(v.here.map((r) => r.command), ['aih codex 1']);
  assert.deepEqual(v.here.map((r) => r.live), [false]);
  assert.deepEqual(v.here.map((r) => r.completed), [true]);
});

test('describeSessionList without a cwd just lists everything', () => {
  const v = persistentSession.describeSessionList(
    [{ name: 's-x', attached: false, path: '' }],
    { cliName: 'codex', id: '1', cwd: '' }
  );
  assert.equal(v.hasCwd, false);
  assert.equal(v.here.length, 0);
  assert.deepEqual(v.others.map((r) => r.command), ['aih codex 1 -M -S x']);
});

test('mirror mode (-M / share): attach shared, never detach the other client', () => {
  const base = 'p-proj-ab12cd34';
  // Planner: a live target under share => 'mirror' (not 'takeover').
  assert.deepEqual(
    persistentSession.planPersistentSession([{ name: base, attached: true }], base, { hasLabel: true, share: true }),
    { session: base, action: 'mirror' }
  );
  // Detached target under share is just a plain reattach (nothing to mirror).
  assert.deepEqual(
    persistentSession.planPersistentSession([{ name: base, attached: false }], base, { hasLabel: true, share: true }),
    { session: base, action: 'reattach' }
  );
  // Same target without share stays an exclusive takeover.
  assert.deepEqual(
    persistentSession.planPersistentSession([{ name: base, attached: true }], base, { hasLabel: true, share: false }),
    { session: base, action: 'takeover' }
  );
  // buildTmuxLaunch: share OMITS -D (shared attach); default keeps -D (exclusive).
  const shared = persistentSession.buildTmuxLaunch({ command: 'claude', args: [] }, { cliName: 'claude', id: '4', sessionName: base, share: true });
  const exclusive = persistentSession.buildTmuxLaunch({ command: 'claude', args: [] }, { cliName: 'claude', id: '4', sessionName: base });
  assert.equal(shared.args.includes('-D'), false);
  assert.equal(exclusive.args.includes('-D'), true);
});
