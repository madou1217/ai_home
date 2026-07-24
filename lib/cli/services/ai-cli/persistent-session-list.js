'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { spawnSync: defaultSpawnSync } = require('node:child_process');
const persistentSession = require('../../../runtime/persistent-session');
const persistentSessionRegistry = require('../../../runtime/persistent-session-registry');
const {
  readAccountCredentials: defaultReadAccountCredentials
} = require('../../../server/account-credential-store');
const { getProviderMeta } = require('../../../provider-catalog');
const { resolveCliPath: defaultResolveCliPath } = require('../../../runtime/platform-runtime');
const {
  normalizeUtf8LocaleEnv,
  requiresProviderAuthProjection
} = require('./provider-runtime-env');
const { shouldRelayClaudeAccount } = require('./claude-account-relay');
const {
  AIH_SERVER_PROFILE_ID,
  supportsAihServerProfile
} = require('../../../account/self-relay-account');
const {
  GATEWAY_RUNTIME_SCOPE,
  resolveRuntimeTarget,
  serializeRuntimeTarget
} = require('../../../account/runtime-target');
const { listSupportedAiClis } = require('./provider-registry');
const { listCliAccountRefRecords } = require('../../../server/account-ref-store');
const { enrichNativeWindowsPsmuxSessions } = require('./psmux-session-enrich');
const { resolveAihRunPath } = require('../../../runtime/aih-storage-layout');
const {
  resolveAgentSessionTitles
} = require('./session-title-resolver');

function dim(text) {
  return `\x1b[90m${text}\x1b[0m`;
}

function cyan(text) {
  return `\x1b[36m${text}\x1b[0m`;
}

function yellow(text) {
  return `\x1b[33m${text}\x1b[0m`;
}

function green(text) {
  return `\x1b[32m${text}\x1b[0m`;
}

function getSessionProviderLabel(provider) {
  const meta = getProviderMeta(provider);
  return meta.short || meta.label || meta.id || String(provider || 'AI').trim() || 'AI';
}

function normalizeSessionId(value) {
  return String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getSessionDisplayDescription(row) {
  const base = String(row && (row.description || row.name) || '').trim();
  const sessionId = normalizeSessionId(row && row.agentSessionId);
  const parts = [];
  if (base) parts.push(base);
  if (sessionId && !base.includes(sessionId)) parts.push(`(${sessionId})`);
  if (isLegacyUtf8RuntimeRow(row)) {
    parts.push('[旧 tmux UTF-8 运行时]');
  }
  if (isCompletedPaneRow(row)) {
    parts.push('[已结束]');
  }
  return parts.join(' ');
}

function isLegacyUtf8RuntimeRow(row) {
  return Boolean(row && row.utf8RuntimeChecked && !row.utf8RuntimeReady);
}

function isCompletedPaneRow(row) {
  return Boolean(row && (
    (row.paneDeadChecked && row.paneDead)
    || (row.screenCompletedChecked && row.screenCompleted)
  ));
}

function isLegacyPsmuxCodexLaunchRuntimeRow(row) {
  return Boolean(row
    && row.cliName === 'codex'
    && row.requirePsmuxCodexLaunchRuntime === true
    && row.psmuxCodexLaunchRuntimeChecked
    && !row.psmuxCodexLaunchRuntimeReady);
}

function needsFreshCompatibleSession(row) {
  return Boolean(persistentSession.getSessionIncompatibility(row, {
    requireUtf8Runtime: row && row.requireUtf8Runtime !== false,
    requireClaudeRenderRuntime: Boolean(row && row.requireClaudeRenderRuntime),
    requireCodexManagedLaunch: Boolean(row && row.requireCodexManagedLaunch),
    requirePsmuxCodexLaunchRuntime: Boolean(row && row.requirePsmuxCodexLaunchRuntime),
    requireProviderSupervisorRuntime: Boolean(row && row.requireProviderSupervisorRuntime)
  }));
}

function deriveSessionCompatibilityRequirements(cliName, runtimeTarget, tmux, options = {}) {
  const processImpl = options.processImpl || process;
  const fsImpl = options.fs || fs;
  const aiHomeDir = String(options.aiHomeDir || '').trim();
  const readAccountCredentials = options.readAccountCredentials || defaultReadAccountCredentials;
  let accountEnv = {};
  if (runtimeTarget && !runtimeTarget.gateway && runtimeTarget.accountRef) {
    try {
      accountEnv = readAccountCredentials(fsImpl, aiHomeDir, runtimeTarget.accountRef) || {};
    } catch (_error) {}
  }
  const authRelayed = shouldRelayClaudeAccount({
    provider: cliName,
    accountRef: runtimeTarget && runtimeTarget.accountRef,
    accountEnv,
    isLogin: false,
    gateway: Boolean(runtimeTarget && runtimeTarget.gateway)
  });
  const gateway = Boolean(runtimeTarget && runtimeTarget.gateway);
  return persistentSession.buildSessionCompatibilityOptions({
    cliName,
    gateway,
    nativeWindowsPsmux: persistentSession.isNativeWindowsPsmuxCommand(
      tmux && tmux.command,
      processImpl.platform
    ),
    usesAuthProjection: requiresProviderAuthProjection(cliName, accountEnv, {
      gateway,
      authRelayed
    })
  });
}

function getSessionAccountLabel(row, fallbackCliName = '', fallbackCliAccountId = '') {
  const cliName = String(row && row.cliName || fallbackCliName || '').trim().toLowerCase();
  const cliAccountId = String(row && row.cliAccountId || fallbackCliAccountId || '').trim();
  if (!cliName && !cliAccountId) return '';
  if (!cliAccountId) return cliName;
  return `${cliName || 'aih'}#${cliAccountId}`;
}

function normalizeSessionProjectPath(row) {
  return String(row && row.path || '').trim() || '未知项目';
}

function getSessionCreated(row) {
  const created = Number(row && row.created);
  return Number.isFinite(created) ? created : 0;
}

function buildTmuxClientEnv(processImpl = {}) {
  return normalizeUtf8LocaleEnv(processImpl.env || {}, {
    platform: processImpl.platform
  });
}

function runTmuxEnvironmentSync(cliName, runtimeScope, tmux, env, options = {}) {
  const spawnSyncImpl = options.spawnSync || defaultSpawnSync;
  const commands = persistentSession.buildSetEnvironmentCommands({
    cliName,
    runtimeScope,
    tmuxCommand: tmux && tmux.command,
    env
  });
  for (const cmd of commands) {
    try {
      spawnSyncImpl(cmd.command, cmd.args, {
        stdio: 'ignore',
        env
      });
    } catch (_error) {}
  }
}


function formatPersistentSessionRow(row, options = {}) {
  const cliName = options.cliName || '';
  const cliAccountId = options.cliAccountId || '';
  const symbols = resolveSessionPickerSymbols(options);
  const dot = row && row.live ? yellow(symbols.liveIcon) : green(symbols.idleIcon);
  const displayDescription = getSessionDisplayDescription(row);
  const description = displayDescription ? `  ${dim(displayDescription)}` : '';
  return `  ${dot} ${getSessionAccountLabel(row, cliName, cliAccountId)}   ${cyan(row.command)}${description}`;
}

function canUseSessionPicker(processImpl = {}, fsImpl, readKey) {
  const stdin = processImpl.stdin || {};
  return Boolean(
    stdin
    && stdin.isTTY
    && processImpl.stdout
    && processImpl.stdout.isTTY
    && (
      typeof readKey === 'function'
      || (
        typeof stdin.fd === 'number'
        && typeof stdin.setRawMode === 'function'
        && fsImpl
        && typeof fsImpl.readSync === 'function'
      )
    )
  );
}

function readSessionPickerKey(processImpl = {}, fsImpl, readKey) {
  if (typeof readKey === 'function') return String(readKey() || '');
  const stdin = processImpl.stdin || {};
  if (!stdin.isTTY || typeof stdin.fd !== 'number' || !fsImpl || typeof fsImpl.readSync !== 'function') {
    return '';
  }
  const buf = Buffer.alloc(8);
  while (true) {
    try {
      const bytes = fsImpl.readSync(stdin.fd, buf, 0, buf.length, null);
      if (bytes > 0) return buf.toString('utf8', 0, bytes);
    } catch (error) {
      const code = String(error && error.code || '').toUpperCase();
      if (code !== 'EAGAIN' && code !== 'EWOULDBLOCK' && code !== 'EINTR') throw error;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
}

function shouldUseSyncSessionPicker(context = {}, processImpl = {}) {
  return typeof context.readSessionPickerKey === 'function'
    || context.forceSyncSessionPicker
    || processImpl.platform === 'win32';
}

const SESSION_PICKER_HEADER = '[aih] 选择要进入的持久会话（Enter=进入，x=关闭选中，X=关闭闲置，↑/↓=选择，q/Esc=退出）';
const SESSION_PICKER_COMPACT_HEADER = '[aih] 选择会话（Enter=进入，x=关闭，↑/↓=选择，q=退出）';
const SESSION_PICKER_TINY_HEADER = '[aih] 选择会话 Enter=进入 q=退出';
const SESSION_PICKER_DEFAULT_COLUMNS = 120;
const SESSION_PICKER_TITLE_MIN_WIDTH = 18;
const SESSION_PICKER_TITLE_MAX_WIDTH = 72;
const SESSION_PICKER_PROJECT_MIN_PATH_WIDTH = 10;
const SESSION_PICKER_BRANCH_MAX_WIDTH = 28;
const SESSION_PICKER_DEFAULT_SYMBOLS = {
  projectIcon: '',
  branchIcon: '⌁',
  liveIcon: '⠿',
  idleIcon: '○',
  liveSpinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
  idlePulse: ['○', '◉', '●', '◉'],
  hint: '⠿=在用 / ○=空闲'
};
const SESSION_PICKER_WINDOWS_SYMBOLS = {
  projectIcon: 'dir',
  branchIcon: 'git:',
  liveIcon: '*',
  idleIcon: 'o',
  liveSpinner: ['*'],
  idlePulse: ['o'],
  hint: '*=在用 / o=空闲'
};
const SESSION_PICKER_RAINBOW_COLORS = [196, 202, 226, 46, 51, 33, 129];
const SESSION_PICKER_ANIMATION_INTERVAL_MS = 400;
// Match readline-style escape timeout behavior: Windows Terminal/PowerShell can
// split arrow-key CSI bytes across scheduler ticks, and treating a lone ESC too
// quickly as "quit" makes Up/Down close the picker.
const SESSION_PICKER_ESCAPE_DELAY_MS = 500;

function resolveSessionPickerSymbols(options = {}) {
  const env = options.env || {};
  const style = String(
    options.symbolStyle
    || env.AIH_SESSION_PICKER_SYMBOLS
    || env.AIH_SESSION_PICKER_ICONS
    || ''
  ).trim().toLowerCase();
  if (style === 'nerd' || style === 'fancy') return SESSION_PICKER_DEFAULT_SYMBOLS;
  if (style === 'ascii' || style === 'plain') return SESSION_PICKER_WINDOWS_SYMBOLS;
  return options.platform === 'win32'
    ? SESSION_PICKER_WINDOWS_SYMBOLS
    : SESSION_PICKER_DEFAULT_SYMBOLS;
}

function resolveSessionPickerAnimationEnabled(options = {}, processImpl = {}) {
  const env = processImpl.env || {};
  const raw = String(
    options.animation
    || options.enableAnimation
    || env.AIH_SESSION_PICKER_ANIMATION
    || ''
  ).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return processImpl.platform !== 'win32';
}

function parseSessionPickerKey(input, options = {}) {
  const text = String(input || '');
  if (!text) return { pending: false, action: '', rest: '' };
  const first = text[0];

  if (first === '\x1b') {
    if (text.length === 1) {
      return options.allowBareEscape
        ? { pending: false, action: 'quit', rest: '' }
        : { pending: true, action: '', rest: text };
    }
    const csi = text.match(/^\x1b\[[0-9;?]*([A-Za-z~])/);
    if (csi) {
      const final = csi[1];
      const action = final === 'A' ? 'up' : final === 'B' ? 'down' : '';
      return { pending: false, action, rest: text.slice(csi[0].length) };
    }
    if (/^\x1b\[[0-9;?]*$/.test(text)) {
      return { pending: true, action: '', rest: text };
    }
    const ss3 = text.match(/^\x1bO([A-Za-z])/);
    if (ss3) {
      const final = ss3[1];
      const action = final === 'A' ? 'up' : final === 'B' ? 'down' : '';
      return { pending: false, action, rest: text.slice(ss3[0].length) };
    }
    if (text === '\x1bO') {
      return { pending: true, action: '', rest: text };
    }
    return { pending: false, action: '', rest: text.slice(1) };
  }

  if (first === '\x00' || first === '\xe0') {
    if (text.length === 1) return { pending: true, action: '', rest: text };
    const key = text[1];
    const action = key === 'H' ? 'up' : key === 'P' ? 'down' : '';
    return { pending: false, action, rest: text.slice(2) };
  }

  if (first === '\r' || first === '\n') return { pending: false, action: 'enter', rest: text.slice(1) };
  if (first === '\x03') return { pending: false, action: 'quit', rest: text.slice(1) };
  if (first === 'x') return { pending: false, action: 'close-selected', rest: text.slice(1) };
  if (first === 'X') return { pending: false, action: 'close-idle', rest: text.slice(1) };
  if (first === 'q' || first === 'Q') return { pending: false, action: 'quit', rest: text.slice(1) };
  if (first === 'k' || first === 'K') return { pending: false, action: 'up', rest: text.slice(1) };
  if (first === 'j' || first === 'J') return { pending: false, action: 'down', rest: text.slice(1) };
  return { pending: false, action: '', rest: text.slice(1) };
}

function charCellWidth(char) {
  const code = char.codePointAt(0);
  if (!code) return 0;
  if (code < 32 || (code >= 0x7f && code < 0xa0)) return 0;
  if (
    (code >= 0x0300 && code <= 0x036f)
    || (code >= 0x1ab0 && code <= 0x1aff)
    || (code >= 0x1dc0 && code <= 0x1dff)
    || (code >= 0x20d0 && code <= 0x20ff)
    || (code >= 0xfe20 && code <= 0xfe2f)
  ) return 0;
  if (
    (code >= 0x1100 && code <= 0x115f)
    || code === 0x2329
    || code === 0x232a
    || (code >= 0x2e80 && code <= 0xa4cf)
    || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xfe10 && code <= 0xfe19)
    || (code >= 0xfe30 && code <= 0xfe6f)
    || (code >= 0xff00 && code <= 0xff60)
    || (code >= 0xffe0 && code <= 0xffe6)
  ) return 2;
  return 1;
}

function cellWidth(value) {
  return Array.from(String(value || '')).reduce((sum, char) => sum + charCellWidth(char), 0);
}

function truncateCells(value, maxWidth) {
  const width = Math.max(0, Number(maxWidth) || 0);
  const text = String(value || '');
  if (cellWidth(text) <= width) return text;
  if (width <= 0) return '';
  const suffix = width > 3 ? '...' : '';
  const bodyWidth = suffix ? width - cellWidth(suffix) : width;
  let used = 0;
  let out = '';
  for (const char of Array.from(text)) {
    const nextWidth = charCellWidth(char);
    if (used + nextWidth > bodyWidth) break;
    out += char;
    used += nextWidth;
  }
  return out + suffix;
}

function padCells(value, width) {
  const text = truncateCells(value, width);
  const padding = Math.max(0, width - cellWidth(text));
  return text + ' '.repeat(padding);
}

function resolveSessionPickerColumns(columns) {
  const parsed = Number(columns);
  if (!Number.isFinite(parsed) || parsed <= 0) return SESSION_PICKER_DEFAULT_COLUMNS;
  return Math.max(1, Math.floor(parsed));
}

function resolveSessionPickerLineWidth(columns) {
  const resolved = resolveSessionPickerColumns(columns);
  return Math.max(1, resolved - 1);
}

function normalizeSessionPickerHomeDir(homeDir = '') {
  return String(homeDir || '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '');
}

function normalizeGitBranchName(value) {
  const branch = String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!branch || branch === 'HEAD') return '';
  return branch;
}

function getSessionGitBranch(row) {
  return normalizeGitBranchName(row && row.gitBranch);
}

function readGitBranchSync(projectPath, options = {}) {
  const cwd = String(projectPath || '').trim();
  if (!cwd || cwd === '未知项目') return '';
  const fsImpl = options.fs || fs;
  if (!isExistingDirectory(fsImpl, cwd)) return '';

  const spawnSyncImpl = options.gitSpawnSync || defaultSpawnSync;
  try {
    const result = spawnSyncImpl('git', ['-C', cwd, 'symbolic-ref', '--quiet', '--short', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 500
    });
    if (!result || result.error || result.status !== 0) return '';
    return normalizeGitBranchName(result.stdout);
  } catch (_error) {
    return '';
  }
}

function resolveProjectGitBranch(projectPath, options = {}) {
  const cwd = String(projectPath || '').trim();
  if (!cwd || cwd === '未知项目') return '';
  const cache = options.gitBranchCache;
  if (cache && cache.has(cwd)) return cache.get(cwd);

  let branch = '';
  try {
    branch = normalizeGitBranchName(
      typeof options.gitBranchResolver === 'function'
        ? options.gitBranchResolver(cwd)
        : readGitBranchSync(cwd, options)
    );
  } catch (_error) {
    branch = '';
  }
  if (cache) cache.set(cwd, branch);
  return branch;
}

function getSessionPickerHomeDir(options = {}) {
  return normalizeSessionPickerHomeDir(
    options.homeDir
    || (process.env && (process.env.HOME || process.env.USERPROFILE))
  );
}

function getProcessHomeDir(processImpl = {}) {
  const env = processImpl.env || {};
  return env.HOME || env.USERPROFILE || '';
}

function formatSessionPickerHeader(layout = {}) {
  const width = resolveSessionPickerLineWidth(layout.columns);
  const candidates = [
    SESSION_PICKER_HEADER,
    SESSION_PICKER_COMPACT_HEADER,
    SESSION_PICKER_TINY_HEADER,
    '[aih] 会话 Enter/q'
  ];
  const header = candidates.find((candidate) => cellWidth(candidate) <= width) || candidates[candidates.length - 1];
  return truncateCells(header, width);
}

function padSessionDescriptionCells(row, width) {
  const base = String(row && (row.description || row.name) || '').trim();
  const sessionId = normalizeSessionId(row && row.agentSessionId);
  const markers = [];
  if (isLegacyUtf8RuntimeRow(row)) markers.push('[旧 tmux UTF-8 运行时]');
  if (isCompletedPaneRow(row)) markers.push('[已结束]');
  const marker = markers.length ? ` ${markers.join(' ')}` : '';
  if (!sessionId) return padCells(`${base}${marker}`, width);

  const suffix = ` (${sessionId})${marker}`;
  const full = base ? `${base}${base.includes(sessionId) ? marker : suffix}` : `(${sessionId})${marker}`;
  const targetWidth = Math.max(0, Number(width) || 0);
  if (cellWidth(full) <= targetWidth) return padCells(full, targetWidth);

  const suffixWidth = cellWidth(suffix);
  if (!base || base.includes(sessionId) || suffixWidth >= targetWidth) {
    return padCells(suffix.trim(), targetWidth);
  }

  const prefixWidth = Math.max(0, targetWidth - suffixWidth);
  return padCells(`${truncateCells(base, prefixWidth)}${suffix}`, targetWidth);
}

function formatSessionPickerStatusIcon(row, selected, animationFrame = 0, symbols = SESSION_PICKER_DEFAULT_SYMBOLS) {
  if (!selected) return row.live ? symbols.liveIcon : symbols.idleIcon;
  const frames = row.live ? symbols.liveSpinner : symbols.idlePulse;
  return frames[Math.abs(Number(animationFrame) || 0) % frames.length];
}

function formatSessionPickerPrefix(row, selected, animationFrame = 0, symbols = SESSION_PICKER_DEFAULT_SYMBOLS) {
  const cursor = selected ? '>' : ' ';
  const dot = formatSessionPickerStatusIcon(row, selected, animationFrame, symbols);
  return `${cursor} ${dot} ${getSessionAccountLabel(row)}  `;
}

function buildSessionPickerDisplayRows(rows) {
  const displayRows = [];
  const groups = new Map();
  let itemIndex = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    const projectPath = normalizeSessionProjectPath(row);
    let group = groups.get(projectPath);
    if (!group) {
      group = { type: 'project', projectPath, gitBranch: getSessionGitBranch(row) };
      groups.set(projectPath, group);
      displayRows.push(group);
    } else if (!group.gitBranch) {
      group.gitBranch = getSessionGitBranch(row);
    }
    displayRows.push({
      type: 'session',
      row,
      itemIndex
    });
    itemIndex += 1;
  }
  return displayRows;
}

function resolveSessionPickerLayout(rows, options = {}) {
  const columns = resolveSessionPickerColumns(options.columns);
  const lineWidth = resolveSessionPickerLineWidth(columns);
  const homeDir = getSessionPickerHomeDir(options);
  const symbols = resolveSessionPickerSymbols(options);
  const prefixes = rows.map((row, index) => formatSessionPickerPrefix(row, index === 0, 0, symbols));
  const prefixWidth = Math.max(...prefixes.map(cellWidth), 0);
  const maxTitleWidth = Math.max(
    ...rows.map((row) => cellWidth(getSessionDisplayDescription(row))),
    SESSION_PICKER_TITLE_MIN_WIDTH
  );
  const availableTitleWidth = Math.max(0, lineWidth - prefixWidth);
  const desiredTitleWidth = Math.min(
    SESSION_PICKER_TITLE_MAX_WIDTH,
    maxTitleWidth,
    availableTitleWidth
  );
  const titleWidth = availableTitleWidth >= SESSION_PICKER_TITLE_MIN_WIDTH
    ? Math.max(SESSION_PICKER_TITLE_MIN_WIDTH, desiredTitleWidth)
    : availableTitleWidth;
  return {
    columns,
    lineWidth,
    titleWidth,
    homeDir,
    platform: options.platform,
    symbols
  };
}

function formatSessionPickerRow(row, selected, layout = {}, animationFrame = 0) {
  const prefix = formatSessionPickerPrefix(row, selected, animationFrame, layout.symbols);
  const lineWidth = resolveSessionPickerLineWidth(layout.columns);
  const titleWidth = Math.max(0, Number(layout.titleWidth) || 0);
  const title = padSessionDescriptionCells(row, titleWidth);
  return truncateCells(`${prefix}${title}`, lineWidth);
}

function formatSessionPickerProjectPath(projectPath, layout = {}) {
  const value = String(projectPath || '').trim().replace(/\\/g, '/');
  const homeDir = normalizeSessionPickerHomeDir(layout.homeDir);
  if (!value || !homeDir) return value || '未知项目';
  if (value === homeDir) return '~';
  if (value.startsWith(`${homeDir}/`)) return `~/${value.slice(homeDir.length + 1)}`;
  return value;
}

function buildProjectHeaderParts(projectPath, gitBranch = '', layout = {}) {
  const lineWidth = resolveSessionPickerLineWidth(layout.columns);
  const symbols = layout.symbols || resolveSessionPickerSymbols(layout);
  if (lineWidth <= 0) {
    return { icon: '', gap: '', path: '', branch: '', plain: '' };
  }

  const icon = truncateCells(symbols.projectIcon, lineWidth);
  if (cellWidth(icon) >= lineWidth) {
    return { icon, gap: '', path: '', branch: '', plain: icon };
  }

  const branchName = normalizeGitBranchName(gitBranch);
  const branchLabel = branchName
    ? `  ${symbols.branchIcon} ${truncateCells(branchName, SESSION_PICKER_BRANCH_MAX_WIDTH)}`
    : '';
  let branch = branchLabel;
  const iconWidth = cellWidth(icon);
  const gap = ' ';
  let pathWidth = Math.max(0, lineWidth - iconWidth - cellWidth(gap) - cellWidth(branch));
  if (branch && pathWidth < SESSION_PICKER_PROJECT_MIN_PATH_WIDTH) {
    branch = '';
    pathWidth = Math.max(0, lineWidth - iconWidth - cellWidth(gap));
  }

  const projectPathLabel = formatSessionPickerProjectPath(projectPath, layout);
  const visiblePath = truncateCells(projectPathLabel, pathWidth);
  const plain = `${icon}${gap}${visiblePath}${branch}`;
  return { icon, gap, path: visiblePath, branch, plain };
}

function colorProjectPath(visiblePath) {
  const slashIndex = String(visiblePath || '').lastIndexOf('/');
  if (slashIndex < 0) return cyan(visiblePath);
  return `${dim(visiblePath.slice(0, slashIndex + 1))}${cyan(visiblePath.slice(slashIndex + 1))}`;
}

function rainbow(text, animationFrame = 0) {
  const frame = Math.abs(Number(animationFrame) || 0);
  return Array.from(String(text || '')).map((char, index) => {
    if (charCellWidth(char) === 0) return char;
    const color = SESSION_PICKER_RAINBOW_COLORS[(index + frame) % SESSION_PICKER_RAINBOW_COLORS.length];
    return `\x1b[38;5;${color}m${char}\x1b[0m`;
  }).join('');
}

function formatSessionProjectHeader(projectPath, gitBranch = '', layout = {}, options = {}) {
  const parts = buildProjectHeaderParts(projectPath, gitBranch, layout);
  if (options.selected) {
    return `${cyan(parts.icon)}${parts.gap}${rainbow(parts.path, options.animationFrame)}${parts.branch ? green(parts.branch) : ''}`;
  }
  return `${cyan(parts.icon)}${parts.gap}${colorProjectPath(parts.path)}${parts.branch ? green(parts.branch) : ''}`;
}

function formatSessionProjectSummaryHeader(projectPath, gitBranch = '', options = {}) {
  const symbols = resolveSessionPickerSymbols(options);
  const branch = normalizeGitBranchName(gitBranch);
  const suffix = branch ? `  ${symbols.branchIcon} ${branch}` : '';
  return dim(`${symbols.projectIcon} ${String(projectPath || '').trim() || '未知项目'}${suffix}`);
}

function formatSessionPickerProjectRow(displayRow, layout = {}, selected = false, animationFrame = 0) {
  return formatSessionProjectHeader(displayRow.projectPath, displayRow.gitBranch, layout, {
    selected,
    animationFrame
  });
}

function formatSessionPickerMessage(message, layout = {}) {
  return truncateCells(`[aih] ${message}`, resolveSessionPickerLineWidth(layout.columns));
}

function buildSessionPickerLines(rows, selectedIndex, layout, message = '', animationFrame = 0) {
  const selectedProjectPath = normalizeSessionProjectPath(rows[selectedIndex]);
  const lines = buildSessionPickerDisplayRows(rows).map((displayRow) => {
    if (displayRow.type === 'project') {
      return formatSessionPickerProjectRow(
        displayRow,
        layout,
        displayRow.projectPath === selectedProjectPath,
        animationFrame
      );
    }
    return formatSessionPickerRow(
      displayRow.row,
      displayRow.itemIndex === selectedIndex,
      layout,
      animationFrame
    );
  });
  if (message) lines.push(formatSessionPickerMessage(message, layout));
  return lines;
}

function getSessionPickerAnimationLines(rows, selectedIndex, layout, animationFrame = 0) {
  const displayRows = buildSessionPickerDisplayRows(rows);
  const selectedProjectPath = normalizeSessionProjectPath(rows[selectedIndex]);
  const lines = [];
  displayRows.forEach((displayRow, displayIndex) => {
    if (displayRow.type === 'project' && displayRow.projectPath === selectedProjectPath) {
      lines.push({
        lineIndex: displayIndex + 1,
        line: formatSessionPickerProjectRow(displayRow, layout, true, animationFrame)
      });
      return;
    }
    if (displayRow.type === 'session' && displayRow.itemIndex === selectedIndex) {
      lines.push({
        lineIndex: displayIndex + 1,
        line: formatSessionPickerRow(displayRow.row, true, layout, animationFrame)
      });
    }
  });
  return lines;
}

function getSessionPickerItemsSignature(rows) {
  return (Array.isArray(rows) ? rows : []).map((row) => [
    row && row.cliName,
    row && row.accountRef,
    row && row.cliAccountId,
    row && row.targetSession,
    row && row.live ? '1' : '0',
    normalizeSessionProjectPath(row),
    getSessionGitBranch(row),
    getSessionDisplayDescription(row)
  ].join('\x1f')).join('\x1e');
}

function renderSessionPickerRows(rows, selectedIndex, write, layout, message = '') {
  const lines = buildSessionPickerLines(rows, selectedIndex, layout, message);
  for (const line of lines) {
    write(`\r\x1b[2K${line}\n`);
  }
  return lines.length;
}

function normalizePickerItems(rows) {
  const groups = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || !row.targetSession) continue;
    const projectPath = normalizeSessionProjectPath(row);
    if (!groups.has(projectPath)) groups.set(projectPath, []);
    groups.get(projectPath).push(row);
  }
  return Array.from(groups.values()).flat();
}

function getSessionCloseLabel(row) {
  const accountLabel = getSessionAccountLabel(row);
  const targetSession = String(row && (row.targetSession || row.name) || '').trim();
  const parts = [];
  if (accountLabel) parts.push(accountLabel);
  if (targetSession) parts.push(targetSession);
  return parts.join(' ');
}

function normalizeCloseSessionResult(row, result) {
  if (result && result.ok === false) {
    return {
      ok: false,
      message: result.message || `关闭 ${getSessionCloseLabel(row) || '会话'} 失败。`
    };
  }
  return {
    ok: true,
    message: `已关闭 ${getSessionCloseLabel(row) || '会话'}。`
  };
}

function closeSelectedSession(row, closeSession) {
  if (!row) {
    return { closed: 0, failed: 0, message: '没有可关闭的会话。' };
  }
  if (typeof closeSession !== 'function') {
    return { closed: 0, failed: 1, message: '当前运行时不支持关闭会话。' };
  }
  try {
    const result = normalizeCloseSessionResult(row, closeSession(row));
    return {
      closed: result.ok ? 1 : 0,
      failed: result.ok ? 0 : 1,
      message: result.message
    };
  } catch (error) {
    return {
      closed: 0,
      failed: 1,
      message: `关闭 ${getSessionCloseLabel(row) || '会话'} 失败：${String(error && error.message || error)}`
    };
  }
}

function closeIdleSessions(rows, closeSession) {
  const idleRows = (Array.isArray(rows) ? rows : []).filter((row) => row && !row.live);
  if (!idleRows.length) {
    return { closed: 0, failed: 0, message: '没有闲置会话可关闭。' };
  }
  if (typeof closeSession !== 'function') {
    return { closed: 0, failed: idleRows.length, message: '当前运行时不支持关闭会话。' };
  }

  let closed = 0;
  let failed = 0;
  for (const row of idleRows) {
    try {
      const result = normalizeCloseSessionResult(row, closeSession(row));
      if (result.ok) closed += 1;
      else failed += 1;
    } catch (_error) {
      failed += 1;
    }
  }

  if (closed > 0 && failed > 0) {
    return { closed, failed, message: `已关闭 ${closed} 个闲置会话，${failed} 个关闭失败。` };
  }
  if (closed > 0) {
    return { closed, failed, message: `已关闭 ${closed} 个闲置会话。` };
  }
  return { closed, failed, message: `${failed} 个闲置会话关闭失败。` };
}

function pickSelectionIndex(items, currentIndex, preferredTarget = '') {
  if (!items.length) return 0;
  const target = String(preferredTarget || '').trim();
  if (target) {
    const nextIndex = items.findIndex((row) => row.targetSession === target);
    if (nextIndex >= 0) return nextIndex;
  }
  return Math.min(Math.max(0, Number(currentIndex) || 0), items.length - 1);
}

function selectPersistentSessionRow(rows, options = {}) {
  let items = normalizePickerItems(rows);
  if (!items.length) return null;
  const processImpl = options.processImpl || process;
  const fsImpl = options.fs || fs;
  const stdout = processImpl.stdout || {};
  const stdin = processImpl.stdin || {};
  const write = typeof stdout.write === 'function'
    ? (text) => stdout.write(text)
    : (text) => console.log(String(text || '').replace(/\n$/, ''));
  const wasRaw = !!stdin.isRaw;
  const wasPaused = typeof stdin.isPaused === 'function' ? stdin.isPaused() : false;
  let selectedIndex = 0;
  let renderedRows = 0;
  let headerRendered = false;
  let message = '';
  let pendingInput = '';
  const refreshItems = (preferredTarget = '', reason = '') => {
    if (typeof options.refreshRows !== 'function') {
      if (reason) message = reason;
      return true;
    }
    const nextItems = normalizePickerItems(options.refreshRows());
    items = nextItems;
    selectedIndex = pickSelectionIndex(items, selectedIndex, preferredTarget);
    if (reason) message = reason;
    return !preferredTarget || items.some((row) => row.targetSession === preferredTarget);
  };

  try {
    if (typeof stdin.setRawMode === 'function') stdin.setRawMode(true);
    if (typeof stdin.resume === 'function') stdin.resume();
    while (true) {
      refreshItems(items[selectedIndex] && items[selectedIndex].targetSession);
      if (!items.length) {
        if (message) write(`\r\x1b[2K${yellow('[aih]')} ${message}\n`);
        write('\r\x1b[2K[aih] 活跃持久会话已全部结束。\n');
        return null;
      }
      const layout = resolveSessionPickerLayout(items, {
        columns: stdout.columns,
        homeDir: options.homeDir || getProcessHomeDir(processImpl),
        platform: processImpl.platform,
        env: processImpl.env
      });
      if (!headerRendered) {
        write(`\r\x1b[2K${formatSessionPickerHeader(layout)}\n`);
        headerRendered = true;
      } else if (renderedRows > 0) {
        write(`\x1b[${renderedRows}A`);
      }
      renderedRows = renderSessionPickerRows(items, selectedIndex, write, layout, message);
      pendingInput += readSessionPickerKey(processImpl, fsImpl, options.readKey);
      let parsedKey = { pending: true, action: '', rest: pendingInput };
      while (pendingInput) {
        parsedKey = parseSessionPickerKey(pendingInput, { allowBareEscape: processImpl.platform !== 'win32' });
        if (parsedKey.pending) break;
        pendingInput = parsedKey.rest;
        if (parsedKey.action) break;
      }
      if (parsedKey.pending) continue;
      const action = parsedKey.action;
      if (action === 'enter') {
        const selected = items[selectedIndex];
        const stillExists = selected && refreshItems(selected.targetSession);
        if (!stillExists) {
          write(`\r\x1b[2K[aih] 所选会话已结束，已刷新列表。\n`);
          renderedRows = 0;
          headerRendered = false;
          continue;
        }
        write('\n');
        return items[selectedIndex];
      }
      if (action === 'close-selected') {
        const result = closeSelectedSession(items[selectedIndex], options.closeSession);
        refreshItems('', result.message);
        renderedRows = 0;
        headerRendered = false;
        continue;
      }
      if (action === 'close-idle') {
        const selectedTarget = items[selectedIndex] && items[selectedIndex].live
          ? items[selectedIndex].targetSession
          : '';
        const result = closeIdleSessions(items, options.closeSession);
        refreshItems(selectedTarget, result.message);
        renderedRows = 0;
        headerRendered = false;
        continue;
      }
      if (action === 'quit') {
        write('\n');
        return null;
      }
      if (action === 'up') {
        selectedIndex = (selectedIndex + items.length - 1) % items.length;
        continue;
      }
      if (action === 'down') {
        selectedIndex = (selectedIndex + 1) % items.length;
      }
    }
  } catch (_error) {
    return null;
  } finally {
    try {
      if (typeof stdin.setRawMode === 'function') stdin.setRawMode(wasRaw);
    } catch (_error) {}
    if (wasPaused && typeof stdin.pause === 'function') {
      try { stdin.pause(); } catch (_error) {}
    }
  }
}

function selectPersistentSessionRowAsync(rows, options = {}) {
  let items = normalizePickerItems(rows);
  if (!items.length) return Promise.resolve(null);
  const processImpl = options.processImpl || process;
  const stdout = processImpl.stdout || {};
  const stdin = processImpl.stdin || {};
  const write = typeof stdout.write === 'function'
    ? (text) => stdout.write(text)
    : (text) => console.log(String(text || '').replace(/\n$/, ''));
  const wasRaw = !!stdin.isRaw;
  const wasPaused = typeof stdin.isPaused === 'function' ? stdin.isPaused() : false;
  let selectedIndex = 0;
  let renderedLineCount = 0;
  let renderedColumns = 0;
  let animationFrame = 0;
  let message = '';
  let done = false;
  let refreshTimer = null;
  let animationTimer = null;
  let pendingInput = '';
  let pendingEscapeTimer = null;
  const escapeDelayMs = Math.max(80, Number(options.escapeDelayMs) || SESSION_PICKER_ESCAPE_DELAY_MS);
  const setEscapeTimer = typeof options.setEscapeTimer === 'function' ? options.setEscapeTimer : setTimeout;
  const clearEscapeTimer = typeof options.clearEscapeTimer === 'function' ? options.clearEscapeTimer : clearTimeout;

  const render = () => {
    const layout = resolveSessionPickerLayout(items, {
      columns: stdout.columns,
      homeDir: options.homeDir || getProcessHomeDir(processImpl),
      platform: processImpl.platform,
      env: processImpl.env
    });
    if (renderedLineCount > 1) write(`\x1b[${renderedLineCount - 1}A`);
    const lines = [
      formatSessionPickerHeader(layout),
      ...buildSessionPickerLines(items, selectedIndex, layout, message, animationFrame)
    ];
    const maxLines = Math.max(lines.length, renderedLineCount);
    for (let i = 0; i < maxLines; i += 1) {
      write(`\r\x1b[2K${lines[i] || ''}`);
      if (i < maxLines - 1) write('\n');
    }
    renderedLineCount = maxLines;
    renderedColumns = layout.columns;
  };

  const renderSelectedAnimationFrame = () => {
    if (done || !items.length || renderedLineCount <= 0) return;
    animationFrame += 1;
    const layout = resolveSessionPickerLayout(items, {
      columns: stdout.columns,
      homeDir: options.homeDir || getProcessHomeDir(processImpl),
      platform: processImpl.platform,
      env: processImpl.env
    });
    if (layout.columns !== renderedColumns) {
      render();
      return;
    }
    const lines = getSessionPickerAnimationLines(items, selectedIndex, layout, animationFrame)
      .filter((line) => line && line.lineIndex >= 0 && line.lineIndex < renderedLineCount)
      .sort((a, b) => b.lineIndex - a.lineIndex);
    if (!lines.length) return;
    let cursorLineIndex = renderedLineCount - 1;
    for (const line of lines) {
      const lineDelta = cursorLineIndex - line.lineIndex;
      if (lineDelta > 0) write(`\x1b[${lineDelta}A`);
      else if (lineDelta < 0) write(`\x1b[${Math.abs(lineDelta)}B`);
      cursorLineIndex = line.lineIndex;
      write(`\r\x1b[2K${line.line}`);
    }
    const linesDown = renderedLineCount - 1 - cursorLineIndex;
    if (linesDown > 0) write(`\x1b[${linesDown}B`);
    write('\r');
  };

  const refreshItems = (preferredTarget = '', reason = '') => {
    if (typeof options.refreshRows !== 'function') {
      return { targetExists: true, changed: false };
    }
    const previousSignature = getSessionPickerItemsSignature(items);
    const previousMessage = message;
    const nextItems = normalizePickerItems(options.refreshRows());
    const selectedTarget = preferredTarget || (items[selectedIndex] && items[selectedIndex].targetSession) || '';
    items = nextItems;
    selectedIndex = pickSelectionIndex(items, selectedIndex, selectedTarget);
    const changed = getSessionPickerItemsSignature(items) !== previousSignature;
    if (reason) {
      message = reason;
    } else if (!items.length) {
      message = '活跃持久会话已全部结束。';
    } else if (changed) {
      message = '会话状态已刷新。';
    }
    return {
      targetExists: !selectedTarget || items.some((row) => row.targetSession === selectedTarget),
      changed: changed || message !== previousMessage
    };
  };

  return new Promise((resolve) => {
    const cleanup = () => {
      if (done) return;
      done = true;
      if (refreshTimer) clearInterval(refreshTimer);
      if (animationTimer) clearInterval(animationTimer);
      if (pendingEscapeTimer) clearEscapeTimer(pendingEscapeTimer);
      try { stdin.off('data', onData); } catch (_error) {}
      try {
        if (typeof stdin.setRawMode === 'function') stdin.setRawMode(wasRaw);
      } catch (_error) {}
      if (wasPaused && typeof stdin.pause === 'function') {
        try { stdin.pause(); } catch (_error) {}
      }
      write('\n');
    };

    const finish = (selected) => {
      cleanup();
      resolve(selected || null);
    };

    const handleAction = (action) => {
      if (!action) return;
      if (action === 'enter') {
        const selected = items[selectedIndex];
        const refreshResult = selected
          ? refreshItems(selected.targetSession, '')
          : { targetExists: false };
        if (!selected || !refreshResult.targetExists) {
          message = items.length ? '所选会话已结束，已刷新列表。' : '所选会话已结束，当前没有活跃持久会话。';
          render();
          return;
        }
        finish(items[selectedIndex]);
        return;
      }
      if (action === 'close-selected') {
        const selected = items[selectedIndex];
        const result = closeSelectedSession(selected, options.closeSession);
        message = result.message;
        refreshItems('', result.message);
        render();
        return;
      }
      if (action === 'close-idle') {
        const selectedTarget = items[selectedIndex] && items[selectedIndex].live
          ? items[selectedIndex].targetSession
          : '';
        const result = closeIdleSessions(items, options.closeSession);
        message = result.message;
        refreshItems(selectedTarget, result.message);
        render();
        return;
      }
      if (action === 'quit') {
        finish(null);
        return;
      }
      if (!items.length) {
        render();
        return;
      }
      if (action === 'up') {
        selectedIndex = (selectedIndex + items.length - 1) % items.length;
        message = '';
        render();
        return;
      }
      if (action === 'down') {
        selectedIndex = (selectedIndex + 1) % items.length;
        message = '';
        render();
      }
    };

    const clearPendingEscapeTimer = () => {
      if (!pendingEscapeTimer) return;
      clearEscapeTimer(pendingEscapeTimer);
      pendingEscapeTimer = null;
    };

    const consumePendingInput = (allowBareEscape = false) => {
      while (pendingInput && !done) {
        const parsed = parseSessionPickerKey(pendingInput, { allowBareEscape });
        if (parsed.pending) {
          if (pendingInput === '\x1b' && !pendingEscapeTimer) {
            pendingEscapeTimer = setEscapeTimer(() => {
              pendingEscapeTimer = null;
              consumePendingInput(true);
            }, escapeDelayMs);
            // Keep this timer referenced. Native Windows terminals can split
            // arrow-key bytes as ESC then "[A"/"[B"; if this timer is unref'ed,
            // the short-lived `aih ss` process may exit before the suffix arrives.
          }
          return;
        }
        clearPendingEscapeTimer();
        pendingInput = parsed.rest;
        handleAction(parsed.action);
      }
    };

    const onData = (chunk) => {
      const key = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
      if (!key) return;
      clearPendingEscapeTimer();
      pendingInput += key;
      consumePendingInput(false);
    };

    try {
      if (typeof stdin.setRawMode === 'function') stdin.setRawMode(true);
      if (typeof stdin.resume === 'function') stdin.resume();
      stdin.on('data', onData);
      render();
      refreshTimer = setInterval(() => {
        if (done) return;
        if (refreshItems().changed) render();
      }, Math.max(300, Number(options.refreshIntervalMs) || 1000));
      if (refreshTimer && typeof refreshTimer.unref === 'function') refreshTimer.unref();
      if (resolveSessionPickerAnimationEnabled(options, processImpl)) {
        animationTimer = setInterval(() => {
          renderSelectedAnimationFrame();
        }, Math.max(120, Number(options.animationIntervalMs) || SESSION_PICKER_ANIMATION_INTERVAL_MS));
        if (animationTimer && typeof animationTimer.unref === 'function') animationTimer.unref();
      }
    } catch (_error) {
      finish(null);
    }
  });
}

function printPersistentProjectGroups(rows, log = console.log, options = {}) {
  const groups = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const projectPath = normalizeSessionProjectPath(row);
    if (!groups.has(projectPath)) {
      groups.set(projectPath, { projectPath, gitBranch: getSessionGitBranch(row), rows: [] });
    }
    const group = groups.get(projectPath);
    if (!group.gitBranch) group.gitBranch = getSessionGitBranch(row);
    group.rows.push(row);
  }
  for (const group of groups.values()) {
    log(formatSessionProjectSummaryHeader(group.projectPath, group.gitBranch, options));
    group.rows.forEach((row) => log(formatPersistentSessionRow(row, options)));
  }
}

// Print the live persistent tmux sessions for one account so a returning user
// can see what is running and how to re-attach each window.
function listPersistentSessions(cliName, accountRef, options = {}) {
  const processImpl = options.processImpl || process;
  const spawnSyncImpl = options.spawnSync || defaultSpawnSync;
  const fsImpl = options.fs || fs;
  const consoleImpl = options.consoleImpl || console;
  const cliAccountId = String(options.cliAccountId || '').trim();
  const runtimeTarget = resolveRuntimeTarget({
    gateway: options.gateway === true,
    accountRef
  });
  if (!runtimeTarget) {
    return { rows: [], socket: '', unavailable: true, unavailableHint: 'Invalid runtime target.' };
  }
  const { runtimeScope } = runtimeTarget;
  const log = typeof consoleImpl.log === 'function' ? consoleImpl.log.bind(consoleImpl) : console.log;
  const resolveTmuxCommand = options.resolveCliPath || options.resolveCommandPath || defaultResolveCliPath;
  const detectTmux = () => persistentSession.detectTmux({
    platform: processImpl.platform,
    env: processImpl.env,
    resolveCommandPath: resolveTmuxCommand,
    existsSync: fsImpl.existsSync
  });
  let tmux = detectTmux();
  const canOfferInstall = processImpl.platform === 'win32'
    && tmux.reason === 'windows-no-tmux'
    && processImpl.stdout
    && processImpl.stdout.isTTY
    && String(processImpl.env.AIH_PSMUX_INSTALL_PROMPT || '1') !== '0'
    && typeof options.askYesNo === 'function';
  if (canOfferInstall) {
    const install = persistentSession.buildWindowsPsmuxInstallCommand();
    log(`\x1b[33m[aih]\x1b[0m Persistent sessions need psmux on Windows: ${persistentSession.PSMUX_INSTALL_URL}`);
    log(`\x1b[90m[aih]\x1b[0m Install command: ${install.display}`);
    if (options.askYesNo('未检测到 psmux，是否通过 winget 安装后继续查看持久会话？', false)) {
      const result = persistentSession.installWindowsPsmux({ spawnSync: spawnSyncImpl, stdio: 'inherit' });
      if (!result.ok) {
        const status = result.status == null ? '' : ` (exit ${result.status})`;
        log(`\x1b[33m[aih]\x1b[0m psmux install failed: ${result.reason}${status}.`);
      }
      tmux = detectTmux();
    }
  }
  if (!tmux.available) {
    const hint = tmux.remediation || (tmux.reason === 'windows-no-tmux'
      ? 'Install psmux or an MSYS2/Cygwin tmux.'
      : 'tmux not found on PATH.');
    if (!options.silentUnavailable) {
      log(`\x1b[33m[aih]\x1b[0m Persistent sessions unavailable: ${hint}`);
    }
    return { rows: [], socket: '', unavailable: true, unavailableHint: hint };
  }
  const tmuxEnv = buildTmuxClientEnv(processImpl);
  const aiHomeDir = String(options.aiHomeDir || '').trim();
  if (!options.collectOnly) {
    runTmuxEnvironmentSync(cliName, runtimeScope, tmux, tmuxEnv, { spawnSync: spawnSyncImpl });
  }
  if (aiHomeDir && !options.collectOnly) {
    const confPath = persistentSession.ensureTmuxConf(resolveAihRunPath(aiHomeDir, 'tmux', 'tmux.conf'), fsImpl, {
      tmuxCommand: tmux.command,
      platform: processImpl.platform
    });
    const sourceConfigCmd = persistentSession.buildSourceConfigCommand({
      cliName,
      runtimeScope,
      tmuxCommand: tmux.command,
      confPath
    });
    if (sourceConfigCmd) {
      try {
        spawnSyncImpl(sourceConfigCmd.command, sourceConfigCmd.args, {
          stdio: 'ignore',
          env: tmuxEnv
        });
      } catch (_error) {}
    }
  }
  const cmd = persistentSession.buildListSessionsCommand({ cliName, runtimeScope, tmuxCommand: tmux.command });
  const res = spawnSyncImpl(cmd.command, cmd.args, {
    encoding: 'utf8',
    env: tmuxEnv
  });
  const sessions = enrichNativeWindowsPsmuxSessions(
    cliName,
    runtimeScope,
    tmux,
    persistentSession.parseSessionList(res && res.stdout),
    {
      spawnSync: spawnSyncImpl,
      env: tmuxEnv,
      platform: processImpl.platform
    }
  );
  if (!sessions.length) {
    if (!options.silentEmpty) {
      log(`\x1b[36m[aih]\x1b[0m ${cliName} #${cliAccountId}：当前没有活跃的持久会话。`);
    }
    return { rows: [], socket: cmd.socket, unavailable: false };
  }
  const cwd = typeof processImpl.cwd === 'function' ? processImpl.cwd() : '';
  const decoratedSessions = typeof options.agentSessionTitleResolver === 'function'
    ? options.agentSessionTitleResolver(cliName, sessions, options)
    : resolveAgentSessionTitles(cliName, sessions, {
      fs: fsImpl,
      hostHomeDir: options.hostHomeDir,
      platform: processImpl.platform,
      DatabaseSync: options.DatabaseSync,
      readCodexThreadRecords: options.readCodexThreadRecords
    });
  const sessionsByName = new Map(decoratedSessions.map((session) => [session.name, session]));
  const compatibilityRequirements = deriveSessionCompatibilityRequirements(
    cliName,
    runtimeTarget,
    tmux,
    { ...options, fs: fsImpl, aiHomeDir, processImpl }
  );
  const view = persistentSession.describeSessionList(decoratedSessions, {
    cliName,
    cliSelector: cliAccountId,
    cwd,
    shareLive: !persistentSession.isNativeWindowsPsmuxCommand(tmux.command, processImpl.platform)
  });
  const gitBranchCache = options.gitBranchCache instanceof Map ? options.gitBranchCache : new Map();
  const rows = [...view.here, ...view.others].map((row) => {
    const source = sessionsByName.get(row.name) || {};
    const projectPath = normalizeSessionProjectPath(row);
    return {
      ...row,
      created: Number(source.created) || 0,
      utf8Runtime: source.utf8Runtime,
      utf8RuntimeChecked: !!source.utf8RuntimeChecked,
      utf8RuntimeReady: !!source.utf8RuntimeReady,
      claudeRenderRuntime: source.claudeRenderRuntime,
      claudeRenderRuntimeChecked: !!source.claudeRenderRuntimeChecked,
      claudeRenderRuntimeReady: !!source.claudeRenderRuntimeReady,
      paneDeadChecked: !!source.paneDeadChecked,
      paneDead: !!source.paneDead,
      screenCompletedChecked: !!source.screenCompletedChecked,
      screenCompleted: !!source.screenCompleted,
      psmuxCodexLaunchRuntime: source.psmuxCodexLaunchRuntime,
      psmuxCodexLaunchRuntimeChecked: !!source.psmuxCodexLaunchRuntimeChecked,
      psmuxCodexLaunchRuntimeReady: !!source.psmuxCodexLaunchRuntimeReady,
      providerSupervisorRuntime: source.providerSupervisorRuntime,
      providerSupervisorRuntimeChecked: !!source.providerSupervisorRuntimeChecked,
      providerSupervisorRuntimeReady: !!source.providerSupervisorRuntimeReady,
      codexManagedLaunch: source.codexManagedLaunch,
      codexManagedLaunchChecked: !!source.codexManagedLaunchChecked,
      codexManagedLaunchReady: !!source.codexManagedLaunchReady,
      ...compatibilityRequirements,
      cliName,
      runtimeScope,
      ...serializeRuntimeTarget(runtimeTarget),
      cliAccountId,
      providerBadge: getSessionProviderLabel(cliName),
      gitBranch: resolveProjectGitBranch(projectPath, {
        fs: fsImpl,
        gitBranchCache,
        gitBranchResolver: options.gitBranchResolver,
        gitSpawnSync: options.gitSpawnSync
      })
    };
  });
  if (options.collectOnly) {
    return { rows, socket: cmd.socket, unavailable: false };
  }

  const hereRows = rows.filter((row) => row.here);
  const otherRows = rows.filter((row) => !row.here);
  log(`\x1b[36m[aih]\x1b[0m ${cliName}#${cliAccountId} 持久会话（socket ${cmd.socket}）：`);
  if (view.hasCwd) {
    log(dim('本项目：'));
    if (hereRows.length) printPersistentProjectGroups(hereRows, log, {
      platform: processImpl.platform,
      env: processImpl.env
    });
    else log(dim('  （本项目暂无会话；运行 ' + `aih ${cliName} ${cliAccountId}` + ' 新建）'));
  }
  if (otherRows.length) {
    log(dim(view.hasCwd ? '其他项目：' : '全部会话：'));
    printPersistentProjectGroups(otherRows, log, {
      platform: processImpl.platform,
      env: processImpl.env
    });
  }
  const symbols = resolveSessionPickerSymbols({ platform: processImpl.platform, env: processImpl.env });
  log(dim(`  提示（${symbols.hint}）：Enter=进入，x=关闭选中，X=关闭闲置，-M=镜像，-R=接管。`));
  return { rows, socket: cmd.socket, unavailable: false };
}

function closePersistentSession(row, options = {}) {
  const injected = options.closePersistentSession || options.closeSession;
  if (typeof injected === 'function') return injected(row);

  const cliName = String(row && row.cliName || '').trim();
  const accountRef = String(row && row.accountRef || '').trim();
  const runtimeTarget = resolveRuntimeTarget({
    gateway: row && row.gateway === true,
    accountRef
  });
  const targetSession = String(row && row.targetSession || row.name || '').trim();
  if (!cliName || !runtimeTarget || !targetSession) {
    return { ok: false, error: 'missing_session_target', message: '缺少可关闭的会话目标。' };
  }

  const processImpl = options.processImpl || process;
  const fsImpl = options.fs || fs;
  const spawnSyncImpl = options.spawnSync || defaultSpawnSync;
  const resolveTmuxCommand = options.resolveCliPath || options.resolveCommandPath || defaultResolveCliPath;
  const tmux = persistentSession.detectTmux({
    platform: processImpl.platform,
    env: processImpl.env,
    resolveCommandPath: resolveTmuxCommand,
    existsSync: fsImpl.existsSync
  });
  if (!tmux.available) {
    const hint = tmux.remediation || 'tmux not found on PATH.';
    return { ok: false, error: 'tmux_unavailable', message: `持久会话不可用：${hint}` };
  }

  const cmd = persistentSession.buildKillSessionCommand({
    cliName,
    runtimeScope: runtimeTarget.runtimeScope,
    sessionName: targetSession,
    tmuxCommand: tmux.command
  });
  if (!cmd) {
    return { ok: false, error: 'unsafe_session_target', message: '会话目标名称不安全，已拒绝关闭。' };
  }

  let result;
  try {
    result = spawnSyncImpl(cmd.command, cmd.args, {
      stdio: 'ignore',
      env: buildTmuxClientEnv(processImpl)
    });
  } catch (error) {
    return {
      ok: false,
      error: 'kill_session_spawn_failed',
      message: `关闭 ${getSessionCloseLabel(row) || '会话'} 失败：${String(error && error.message || error)}`
    };
  }

  const status = result && Number.isInteger(result.status) ? result.status : 0;
  if (result && result.error) {
    return {
      ok: false,
      error: 'kill_session_error',
      message: `关闭 ${getSessionCloseLabel(row) || '会话'} 失败：${String(result.error.message || result.error)}`
    };
  }
  if (status !== 0) {
    return {
      ok: false,
      error: 'kill_session_failed',
      status,
      message: `关闭 ${getSessionCloseLabel(row) || '会话'} 失败（exit ${status}）。`
    };
  }

  return { ok: true, session: targetSession, socket: cmd.socket };
}

function listProviderAccountScopes(provider, options = {}) {
  const fsImpl = options.fs || fs;
  const aiHomeDir = String(options.aiHomeDir || '').trim();
  if (!aiHomeDir) return [];
  const scopes = listCliAccountRefRecords(fsImpl, aiHomeDir, provider, { bestEffort: true })
    .map((record) => ({
      provider: String(record.provider || '').trim(),
      accountRef: String(record.accountRef || '').trim(),
      cliAccountId: String(record.cliAccountId || '').trim(),
      gateway: false,
      runtimeScope: String(record.accountRef || '').trim()
    }))
    .filter((record) => record.provider && record.accountRef && record.cliAccountId)
    .sort((left, right) => compareCliAccountIds(left.cliAccountId, right.cliAccountId));
  if (supportsAihServerProfile(provider)) {
    scopes.unshift({
      provider,
      accountRef: '',
      cliAccountId: AIH_SERVER_PROFILE_ID,
      gateway: true,
      runtimeScope: GATEWAY_RUNTIME_SCOPE
    });
  }
  return scopes;
}

function isExistingDirectory(fsImpl, targetPath) {
  try {
    return Boolean(targetPath && fsImpl.statSync(targetPath).isDirectory());
  } catch (_error) {
    return false;
  }
}

function compareCliAccountIds(left, right) {
  if (left === AIH_SERVER_PROFILE_ID) return right === AIH_SERVER_PROFILE_ID ? 0 : -1;
  if (right === AIH_SERVER_PROFILE_ID) return 1;
  return Number(left) - Number(right);
}

function collectRegistrySessionTargets(aiHomeDir, providers, options = {}) {
  const fsImpl = options.fs || fs;
  const providerSet = new Set((Array.isArray(providers) ? providers : []).map((provider) => String(provider || '').trim()).filter(Boolean));
  const registeredByRef = new Map(
    listCliAccountRefRecords(fsImpl, aiHomeDir, '', { bestEffort: true })
      .map((record) => [String(record.accountRef || '').trim(), record])
      .filter(([accountRef]) => accountRef)
  );
  const targets = [];
  const seen = new Set();
  let entries = [];
  try {
    entries = persistentSessionRegistry.listEntries(aiHomeDir, { fs: fsImpl });
  } catch (_error) {
    entries = [];
  }
  for (const entry of entries) {
    const provider = String(entry && entry.provider || '').trim();
    const accountRef = String(entry && entry.accountRef || '').trim();
    const gateway = entry && entry.gateway === true;
    if (!provider || entry.unrecoverable) continue;
    if (providerSet.size && !providerSet.has(provider)) continue;
    if (gateway) {
      if (!supportsAihServerProfile(provider) || entry.runtimeScope !== GATEWAY_RUNTIME_SCOPE) continue;
      const key = `${provider}\0${GATEWAY_RUNTIME_SCOPE}`;
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push({
        provider,
        accountRef: '',
        cliAccountId: AIH_SERVER_PROFILE_ID,
        gateway: true,
        runtimeScope: GATEWAY_RUNTIME_SCOPE
      });
      continue;
    }
    if (!accountRef) continue;
    const registered = registeredByRef.get(accountRef);
    if (!registered || registered.provider !== provider) continue;
    const key = `${provider}\0${accountRef}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({
      provider,
      accountRef,
      cliAccountId: String(registered.cliAccountId || '').trim(),
      gateway: false,
      runtimeScope: accountRef
    });
  }
  return targets.sort((left, right) => {
    const providerOrder = (Array.isArray(providers) ? providers : []).indexOf(left.provider)
      - (Array.isArray(providers) ? providers : []).indexOf(right.provider);
    if (providerOrder) return providerOrder;
    return compareCliAccountIds(left.cliAccountId, right.cliAccountId);
  });
}

function collectSessionRowsForTargets(targets, context = {}) {
  const processImpl = context.processImpl || process;
  const consoleImpl = context.consoleImpl || console;
  const fsImpl = context.fs || fs;
  const gitBranchCache = context.gitBranchCache instanceof Map
    ? context.gitBranchCache
    : new Map();
  context.gitBranchCache = gitBranchCache;
  const aiHomeDir = String(context.aiHomeDir || '').trim();
  const rows = [];
  let accountCount = 0;
  let unavailableCount = 0;
  let unavailableHint = '';

  for (const target of Array.isArray(targets) ? targets : []) {
    const provider = String(target && target.provider || '').trim();
    const accountRef = String(target && target.accountRef || '').trim();
    const cliAccountId = String(target && target.cliAccountId || '').trim();
    const runtimeTarget = resolveRuntimeTarget({
      gateway: target && target.gateway === true,
      accountRef
    });
    if (!provider || !runtimeTarget || !cliAccountId) continue;
    accountCount += 1;
    const result = listPersistentSessions(provider, accountRef, {
      processImpl,
      fs: fsImpl,
      spawnSync: context.spawnSync,
      resolveCliPath: context.resolveCliPath,
      aiHomeDir,
      cliAccountId,
      gateway: runtimeTarget.gateway,
      hostHomeDir: context.hostHomeDir,
      agentSessionTitleResolver: context.agentSessionTitleResolver,
      readCodexThreadRecords: context.readCodexThreadRecords,
      DatabaseSync: context.DatabaseSync,
      gitBranchCache,
      gitBranchResolver: context.gitBranchResolver,
      gitSpawnSync: context.gitSpawnSync,
      collectOnly: true,
      silentEmpty: true,
      silentUnavailable: true,
      consoleImpl
    });
    if (result && result.unavailable) {
      unavailableCount += 1;
      if (!unavailableHint && result.unavailableHint) unavailableHint = result.unavailableHint;
    }
    if (result && Array.isArray(result.rows)) {
      rows.push(...result.rows);
    }
  }

  return { rows, accountCount, unavailableCount, unavailableHint };
}

function buildGlobalSessionGroups(rows) {
  const groupsByProject = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const projectPath = normalizeSessionProjectPath(row);
    if (!groupsByProject.has(projectPath)) {
      groupsByProject.set(projectPath, { projectPath, gitBranch: '', rows: [], latestCreated: 0 });
    }
    const group = groupsByProject.get(projectPath);
    if (!group.gitBranch) group.gitBranch = getSessionGitBranch(row);
    group.rows.push(row);
    group.latestCreated = Math.max(group.latestCreated, getSessionCreated(row));
  }
  return Array.from(groupsByProject.values())
    .map((group) => ({
      ...group,
      rows: group.rows.slice().sort((left, right) => getSessionCreated(right) - getSessionCreated(left))
    }))
    .sort((left, right) => right.latestCreated - left.latestCreated);
}

function formatGlobalPersistentSessionsByProject(rows, options = {}) {
  const groups = buildGlobalSessionGroups(rows);
  if (!groups.length) return '';
  const symbols = resolveSessionPickerSymbols(options);
  const lines = [`${cyan('[aih]')} 活跃持久会话：`];
  for (const group of groups) {
    lines.push(formatSessionProjectSummaryHeader(group.projectPath, group.gitBranch, options));
    for (const row of group.rows) {
      lines.push(formatPersistentSessionRow(row, options));
    }
  }
  lines.push(dim(`  提示（${symbols.hint}）：Enter=进入，x=关闭选中，X=关闭闲置，-M=镜像，-R=接管。`));
  return lines.join('\n');
}

function printGlobalSessionsHelp(log = console.log) {
  log(`
\x1b[36mAI Home (aih)\x1b[0m - 活跃持久会话

\x1b[33mUsage:\x1b[0m
  aih sessions              \x1b[90m上下选择活跃持久会话\x1b[0m
  aih ss                    \x1b[90m同 aih sessions\x1b[0m
  aih ss --list             \x1b[90m按项目预览所有会话和可复制命令\x1b[0m

\x1b[33mInteractive keys:\x1b[0m
  Enter                     \x1b[90m进入选中会话\x1b[0m
  x                         \x1b[90m关闭选中会话\x1b[0m
  X                         \x1b[90m关闭所有闲置会话\x1b[0m
  q / Esc                   \x1b[90m退出选择器\x1b[0m

\x1b[33mDetail aliases:\x1b[0m
  --list, -l, --details, -v, -vv, -vvv, list, detail, details, vvv
`);
}

function parseGlobalSessionsArgs(args) {
  const tokens = Array.isArray(args) ? args.map((item) => String(item || '').trim()).filter(Boolean) : [];
  const first = tokens[0] || '';
  if (!first) return { ok: true, help: false, detail: false };
  if (tokens.length > 1) return { ok: false };
  if (first === '--help' || first === '-h' || first === 'help') {
    return { ok: true, help: true, detail: false };
  }
  const detailTokens = new Set([
    '--list',
    '-l',
    '--detail',
    '--details',
    '--verbose',
    '-v',
    '-vv',
    '-vvv',
    'list',
    'detail',
    'details',
    'vvv'
  ]);
  if (detailTokens.has(first)) return { ok: true, help: false, detail: true };
  return { ok: false };
}

function collectGlobalPersistentSessionRows(context = {}) {
  const processImpl = context.processImpl || process;
  const fsImpl = context.fs || fs;
  const providers = Array.isArray(context.providers) && context.providers.length
    ? context.providers
    : listSupportedAiClis();
  const aiHomeDir = String(context.aiHomeDir || '').trim();
  const scanAll = context.forceFullSessionScan
    || String(processImpl.env && processImpl.env.AIH_SESSION_SCAN_ALL || '') === '1';

  if (aiHomeDir && !scanAll) {
    const registryTargets = collectRegistrySessionTargets(aiHomeDir, providers, { fs: fsImpl });
    if (registryTargets.length) {
      const registrySummary = collectSessionRowsForTargets(registryTargets, context);
      if (registrySummary.rows.length) return registrySummary;
    }
  }

  const targets = [];
  for (const provider of providers) {
    targets.push(...listProviderAccountScopes(provider, { fs: fsImpl, aiHomeDir }));
  }
  return collectSessionRowsForTargets(targets, context);
}

function printGlobalSessionEmptyState(summary, log) {
  if (summary.accountCount > 0 && summary.unavailableCount === summary.accountCount && summary.unavailableHint) {
    log(`\x1b[33m[aih]\x1b[0m Persistent sessions unavailable: ${summary.unavailableHint}`);
  } else {
    log('\x1b[36m[aih]\x1b[0m 当前没有活跃的持久会话。');
  }
}

function getProcessCwd(processImpl = {}) {
  try {
    return typeof processImpl.cwd === 'function' ? String(processImpl.cwd() || '') : '';
  } catch (_error) {
    return '';
  }
}

function clearPersistentSessionTargetEnv(env = {}) {
  delete env[persistentSession.TARGET_ENV];
  delete env[persistentSession.MIRROR_ENV];
}

function runFromSessionProject(row, context, invoke) {
  const processImpl = context.processImpl || process;
  const projectPath = String(row && row.path || '').trim();
  const currentPath = getProcessCwd(processImpl);
  const canChangeDirectory = projectPath
    && projectPath !== currentPath
    && typeof processImpl.chdir === 'function';
  if (!canChangeDirectory) {
    invoke();
    return true;
  }

  const consoleImpl = context.consoleImpl || console;
  const error = typeof consoleImpl.error === 'function' ? consoleImpl.error.bind(consoleImpl) : console.error;
  try {
    processImpl.chdir(projectPath);
  } catch (chdirError) {
    error(`\x1b[31m[aih] Cannot enter selected session project: ${String(chdirError && chdirError.message || chdirError)}\x1b[0m`);
    return false;
  }

  try {
    invoke();
    return true;
  } finally {
    if (currentPath) {
      try { processImpl.chdir(currentPath); } catch (_error) {}
    }
  }
}

function enterGlobalPersistentSession(selected, context = {}) {
  const cliName = String(selected && selected.cliName || '').trim();
  const accountRef = String(selected && selected.accountRef || '').trim();
  const runtimeTarget = resolveRuntimeTarget({
    gateway: selected && selected.gateway === true,
    accountRef
  });
  const cliAccountId = String(selected && selected.cliAccountId || '').trim();
  const targetSession = String(selected && selected.targetSession || '').trim();
  if (!cliName || !runtimeTarget || !cliAccountId || typeof context.runCliPty !== 'function') {
    return false;
  }
  const processImpl = context.processImpl || process;
  const env = processImpl.env || (processImpl.env = {});
  if (needsFreshCompatibleSession(selected)) {
    clearPersistentSessionTargetEnv(env);
    return runFromSessionProject(selected, context, () => {
      context.runCliPty(cliName, runtimeTarget.accountRef, [], false, {
        cliAccountId,
        gateway: runtimeTarget.gateway
      });
    });
  }

  if (!targetSession) return false;
  env[persistentSession.TARGET_ENV] = targetSession;
  env[persistentSession.MIRROR_ENV] = '1';
  context.runCliPty(cliName, runtimeTarget.accountRef, [], false, {
    cliAccountId,
    gateway: runtimeTarget.gateway
  });
  return true;
}

function runGlobalPersistentSessionsCommand(args, context = {}) {
  const processImpl = context.processImpl || process;
  const consoleImpl = context.consoleImpl || console;
  const log = typeof consoleImpl.log === 'function' ? consoleImpl.log.bind(consoleImpl) : console.log;
  const error = typeof consoleImpl.error === 'function' ? consoleImpl.error.bind(consoleImpl) : console.error;
  const parsedArgs = parseGlobalSessionsArgs(args);

  if (parsedArgs.help) {
    printGlobalSessionsHelp(log);
    return 0;
  }
  if (!parsedArgs.ok) {
    error('\x1b[31m[aih] Invalid arg. Usage: aih sessions [--list]\x1b[0m');
    return 1;
  }

  const fsImpl = context.fs || fs;
  let summary = collectGlobalPersistentSessionRows(context);
  // Lazy post-reboot restore: keep the hot path fast when live psmux/tmux
  // sessions already exist, and only reconcile the registry if the first scan
  // found nothing to enter.
  if (!summary.rows.length && typeof context.restorePersistentSessions === 'function') {
    try {
      context.restorePersistentSessions({ reason: 'sessions-command' });
      summary = collectGlobalPersistentSessionRows(context);
    } catch (_restoreError) {}
  }

  if (!summary.rows.length) {
    printGlobalSessionEmptyState(summary, log);
    return 0;
  }

  if (parsedArgs.detail) {
    log(formatGlobalPersistentSessionsByProject(summary.rows, {
      platform: processImpl.platform,
      env: processImpl.env
    }));
    return 0;
  }

  const interactivePicker = canUseSessionPicker(processImpl, fsImpl, context.readSessionPickerKey);
  if (!interactivePicker) {
    log('\x1b[33m[aih]\x1b[0m 当前终端不支持交互选择；使用 `aih ss --list` 查看会话详情。');
    return 0;
  }

  const handleSelected = (selected) => {
    if (!selected) return 0;
    if (typeof context.enterPersistentSession === 'function') {
      context.enterPersistentSession(selected);
      return { entered: true };
    }
    if (enterGlobalPersistentSession(selected, context)) return { entered: true };
    error('\x1b[31m[aih] Cannot enter selected session: PTY runtime is unavailable.\x1b[0m');
    return 1;
  };
  const pickerOptions = {
    processImpl,
    fs: fsImpl,
    readKey: context.readSessionPickerKey,
    refreshRows: () => collectGlobalPersistentSessionRows(context).rows,
    closeSession: (row) => closePersistentSession(row, context),
    refreshIntervalMs: context.sessionPickerRefreshIntervalMs
  };
  const useSyncPicker = shouldUseSyncSessionPicker(context, processImpl);
  if (useSyncPicker) {
    return handleSelected(selectPersistentSessionRow(summary.rows, pickerOptions));
  }
  return selectPersistentSessionRowAsync(summary.rows, pickerOptions).then(handleSelected);
}

module.exports = {
  getSessionDisplayDescription,
  isLegacyUtf8RuntimeRow,
  isLegacyPsmuxCodexLaunchRuntimeRow,
  isCompletedPaneRow,
  needsFreshCompatibleSession,
  enrichNativeWindowsPsmuxSessions,
  getSessionAccountLabel,
  normalizeSessionProjectPath,
  canUseSessionPicker,
  shouldUseSyncSessionPicker,
  selectPersistentSessionRow,
  selectPersistentSessionRowAsync,
  formatPersistentSessionRow,
  listPersistentSessions,
  closePersistentSession,
  listProviderAccountScopes,
  buildGlobalSessionGroups,
  formatGlobalPersistentSessionsByProject,
  parseGlobalSessionsArgs,
  collectGlobalPersistentSessionRows,
  printGlobalSessionsHelp,
  enterGlobalPersistentSession,
  runGlobalPersistentSessionsCommand
};
