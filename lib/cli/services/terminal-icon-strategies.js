'use strict';

function normalizeText(value) {
  return String(value || '').trim();
}

function lowerText(value) {
  return normalizeText(value).toLowerCase();
}

function hasEnv(env, key) {
  return Boolean(normalizeText(env && env[key]));
}

function termContains(env, fragment) {
  return lowerText(env && env.TERM).includes(lowerText(fragment));
}

function termProgramEquals(env, value) {
  return lowerText(env && env.TERM_PROGRAM) === lowerText(value);
}

const TERMINAL_ICON_STRATEGIES = Object.freeze([
  Object.freeze({
    id: 'windows-terminal',
    label: 'Windows Terminal',
    platforms: ['win32'],
    defaultOn: ['Windows 11', 'recent Windows desktop'],
    mainstream: true,
    graphicalIconMode: 'profile-icon',
    runtimeActivation: 'launch-profile',
    titleFallback: true,
    detect: (env) => hasEnv(env, 'WT_SESSION') || hasEnv(env, 'WT_PROFILE_ID') || hasEnv(env, 'WtProfileId')
  }),
  Object.freeze({
    id: 'windows-console-host',
    label: 'Windows Console Host',
    platforms: ['win32'],
    defaultOn: ['legacy Windows'],
    mainstream: true,
    graphicalIconMode: '',
    runtimeActivation: '',
    titleFallback: true,
    detect: (env) => termProgramEquals(env, 'Windows_Console_Host')
  }),
  Object.freeze({
    id: 'iterm2',
    label: 'iTerm2',
    platforms: ['darwin'],
    defaultOn: [],
    mainstream: true,
    graphicalIconMode: 'profile-icon',
    runtimeActivation: 'osc-1337-set-profile',
    titleFallback: true,
    detect: (env) => termProgramEquals(env, 'iTerm.app') || hasEnv(env, 'ITERM_SESSION_ID')
  }),
  Object.freeze({
    id: 'apple-terminal',
    label: 'Apple Terminal',
    platforms: ['darwin'],
    defaultOn: ['macOS'],
    mainstream: true,
    graphicalIconMode: '',
    runtimeActivation: '',
    titleFallback: true,
    detect: (env) => termProgramEquals(env, 'Apple_Terminal')
  }),
  Object.freeze({
    id: 'konsole',
    label: 'Konsole',
    platforms: ['linux', 'freebsd'],
    defaultOn: ['KDE Plasma'],
    mainstream: true,
    graphicalIconMode: 'profile-icon',
    runtimeActivation: 'dbus-set-profile',
    titleFallback: true,
    detect: (env) => hasEnv(env, 'KONSOLE_DBUS_SERVICE') || hasEnv(env, 'KONSOLE_DBUS_SESSION')
  }),
  Object.freeze({
    id: 'gnome-terminal',
    label: 'GNOME Terminal',
    platforms: ['linux', 'freebsd'],
    defaultOn: ['Ubuntu Desktop', 'GNOME desktop'],
    mainstream: true,
    graphicalIconMode: 'launcher-icon',
    runtimeActivation: '',
    titleFallback: true,
    detect: (env) => hasEnv(env, 'GNOME_TERMINAL_SCREEN') || hasEnv(env, 'GNOME_TERMINAL_SERVICE')
  }),
  Object.freeze({
    id: 'xfce-terminal',
    label: 'Xfce Terminal',
    platforms: ['linux', 'freebsd'],
    defaultOn: ['Xfce desktop'],
    mainstream: true,
    graphicalIconMode: 'launcher-icon',
    runtimeActivation: '',
    titleFallback: true,
    detect: (env) => hasEnv(env, 'XFCE_TERMINAL_WINDOW')
  }),
  Object.freeze({
    id: 'wezterm',
    label: 'WezTerm',
    platforms: ['darwin', 'linux', 'win32', 'freebsd'],
    defaultOn: [],
    mainstream: true,
    graphicalIconMode: '',
    runtimeActivation: '',
    titleFallback: true,
    detect: (env) => hasEnv(env, 'WEZTERM_PANE') || termProgramEquals(env, 'WezTerm')
  }),
  Object.freeze({
    id: 'warp',
    label: 'Warp',
    platforms: ['darwin', 'linux', 'win32'],
    defaultOn: [],
    mainstream: true,
    graphicalIconMode: 'agent-command',
    runtimeActivation: 'settings-agent-command',
    titleFallback: true,
    detect: (env) => termProgramEquals(env, 'WarpTerminal')
      || termProgramEquals(env, 'Warp')
      || hasEnv(env, 'WARP_IS_LOCAL_SHELL_SESSION')
      || hasEnv(env, 'WARP_SESSION_ID')
  }),
  Object.freeze({
    id: 'kitty',
    label: 'kitty',
    platforms: ['darwin', 'linux', 'freebsd'],
    defaultOn: [],
    mainstream: true,
    graphicalIconMode: '',
    runtimeActivation: '',
    titleFallback: true,
    detect: (env) => hasEnv(env, 'KITTY_WINDOW_ID') || termContains(env, 'xterm-kitty')
  }),
  Object.freeze({
    id: 'alacritty',
    label: 'Alacritty',
    platforms: ['darwin', 'linux', 'win32', 'freebsd'],
    defaultOn: [],
    mainstream: true,
    graphicalIconMode: '',
    runtimeActivation: '',
    titleFallback: true,
    detect: (env) => hasEnv(env, 'ALACRITTY_WINDOW_ID') || termProgramEquals(env, 'Alacritty')
  }),
  Object.freeze({
    id: 'ghostty',
    label: 'Ghostty',
    platforms: ['darwin', 'linux'],
    defaultOn: [],
    mainstream: true,
    graphicalIconMode: '',
    runtimeActivation: '',
    titleFallback: true,
    detect: (env) => termProgramEquals(env, 'Ghostty') || hasEnv(env, 'GHOSTTY_RESOURCES_DIR')
  }),
  Object.freeze({
    id: 'vscode',
    label: 'VS Code Integrated Terminal',
    platforms: ['darwin', 'linux', 'win32'],
    defaultOn: [],
    mainstream: true,
    graphicalIconMode: '',
    runtimeActivation: '',
    titleFallback: true,
    detect: (env) => termProgramEquals(env, 'vscode') || hasEnv(env, 'VSCODE_INJECTION')
  })
]);

const PLATFORM_DEFAULT_TERMINALS = Object.freeze({
  darwin: 'apple-terminal',
  win32: 'windows-terminal',
  linux: 'gnome-terminal'
});

function platformMatches(strategy, platform) {
  if (!platform) return true;
  return !Array.isArray(strategy.platforms) || strategy.platforms.length === 0 || strategy.platforms.includes(platform);
}

function findTerminalIconStrategyById(id) {
  const normalized = lowerText(id);
  return TERMINAL_ICON_STRATEGIES.find((strategy) => strategy.id === normalized) || null;
}

function detectTerminalIconStrategy(options = {}) {
  const env = options.env || process.env;
  const platform = normalizeText(options.platform || process.platform);
  const override = lowerText(options.terminal || env.AIH_TERMINAL_ICON_STRATEGY);
  if (override) {
    const explicit = findTerminalIconStrategyById(override);
    if (explicit) return explicit;
  }
  for (const strategy of TERMINAL_ICON_STRATEGIES) {
    if (!platformMatches(strategy, platform)) continue;
    if (typeof strategy.detect === 'function' && strategy.detect(env, platform)) return strategy;
  }
  return findTerminalIconStrategyById(PLATFORM_DEFAULT_TERMINALS[platform]) || null;
}

function listTerminalIconStrategies() {
  return TERMINAL_ICON_STRATEGIES.map((strategy) => ({
    id: strategy.id,
    label: strategy.label,
    platforms: strategy.platforms.slice(),
    defaultOn: strategy.defaultOn.slice(),
    mainstream: Boolean(strategy.mainstream),
    graphicalIconMode: strategy.graphicalIconMode,
    runtimeActivation: strategy.runtimeActivation,
    titleFallback: Boolean(strategy.titleFallback)
  }));
}

module.exports = {
  detectTerminalIconStrategy,
  findTerminalIconStrategyById,
  listTerminalIconStrategies
};
