'use strict';

function normalizeInputText(data) {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  return String(data || '');
}

function isShellDrawerToggleSequence(data) {
  const text = normalizeInputText(data);
  if (!text) return false;

  const defaultShortcuts = new Set([
    '\x1b\n', // Alt+Ctrl+J in many legacy terminals
    '\x1b\x0a',
    '\x1b[106;7u', // CSI-u: Ctrl+Alt+j
    '\x1b[74;7u', // CSI-u: Ctrl+Alt+J
    '\x1b[27;7;106~', // modifyOtherKeys: Ctrl+Alt+j
    '\x1b[27;7;74~' // modifyOtherKeys: Ctrl+Alt+J
  ]);

  return defaultShortcuts.has(text);
}

function shouldEnableShellDrawer(isLogin, forwardArgs, processObj) {
  if (isLogin) return false;
  if (Array.isArray(forwardArgs) && forwardArgs.length > 0) return false;
  const stdin = processObj && processObj.stdin;
  const stdout = processObj && processObj.stdout;
  return Boolean(stdin && stdout && stdin.isTTY && (stdout.isTTY !== false));
}

function getShellDrawerTotalHeight(processObj) {
  const rows = Math.max(8, Number(processObj && processObj.stdout && processObj.stdout.rows) || 24);
  const preferred = Number(processObj && processObj.env && processObj.env.AIH_SHELL_DRAWER_HEIGHT) || 7;
  const clamped = Math.max(5, Math.min(preferred, rows - 3));
  return clamped;
}

function getShellDrawerPtyRows(processObj) {
  return Math.max(2, getShellDrawerTotalHeight(processObj) - 3);
}

function resolveShellDrawerLaunch(processObj) {
  if (processObj && processObj.platform === 'win32') {
    return {
      command: String((processObj.env && processObj.env.ComSpec) || 'cmd.exe'),
      args: []
    };
  }

  const envShell = String(processObj && processObj.env && processObj.env.SHELL || '').trim();
  if (envShell) {
    return { command: envShell, args: [] };
  }

  return { command: '/bin/sh', args: [] };
}

module.exports = {
  getShellDrawerPtyRows,
  getShellDrawerTotalHeight,
  isShellDrawerToggleSequence,
  resolveShellDrawerLaunch,
  shouldEnableShellDrawer
};
