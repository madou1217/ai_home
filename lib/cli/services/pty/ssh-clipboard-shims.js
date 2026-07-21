'use strict';

// SSH clipboard command shims: puts pbcopy/pbpaste/xclip/... shims on PATH for
// the child CLI so clipboard traffic from a REMOTE (SSH) aih is bridged back
// through the local terminal instead of touching the remote clipboard.
// Extracted from pty/runtime.js; spawnPty installs these into envOverrides.

const { DEFAULT_SHIM_TIMEOUT_MS } = require('../ssh-clipboard/shim-protocol');
const {
  buildSshClipboardSessionKey,
  createSshClipboardInbox
} = require('../ssh-clipboard/inbox');
const { resolveAihRunPath } = require('../../../runtime/aih-storage-layout');

function createSshClipboardShims(deps = {}) {
  const {
    fs,
    path,
    processObj,
    aiHomeDir
  } = deps;

  function shellQuote(value) {
    return `'${String(value || '').replace(/'/g, '\'\"\'\"\'')}'`;
  }

  function shouldEnableSshClipboardCommandShims() {
    if (processObj.platform === 'win32') return false;
    if (!String(processObj.env.SSH_CONNECTION || '').trim() && !String(processObj.env.SSH_TTY || '').trim()) return false;
    if (String(processObj.env.AIH_SSH_IMAGE_PASTE || '1') === '0') return false;
    if (String(processObj.env.AIH_SSH_TERMINAL_CLIPBOARD || '1') === '0') return false;
    return String(processObj.env.AIH_SSH_CLIPBOARD_SHIMS || '1') !== '0';
  }

  function sshClipboardShimTools() {
    return ['xclip', 'wl-paste', 'pbpaste', 'pngpaste', 'osascript'];
  }

  function ensureSshClipboardShimBin(binDir) {
    try {
      fs.mkdirSync(binDir, { recursive: true });
      const shimBin = path.join(__dirname, '..', 'ssh-clipboard', 'shim-bin.js');
      sshClipboardShimTools().forEach((tool) => {
        const filePath = path.join(binDir, tool);
        const content = [
          '#!/bin/sh',
          `exec ${shellQuote(processObj.execPath)} ${shellQuote(shimBin)} ${shellQuote(tool)} "$@"`,
          ''
        ].join('\n');
        fs.writeFileSync(filePath, content, 'utf8');
        if (typeof fs.chmodSync === 'function') {
          try { fs.chmodSync(filePath, 0o755); } catch (_error) {}
        }
      });
      return true;
    } catch (_error) {
      return false;
    }
  }

  function realShimToolEnvKey(tool) {
    const key = String(tool || '')
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
    return key ? `AIH_SSH_CLIP_REAL_${key}` : '';
  }

  function resolveRealShimToolPath(tool, currentPath, binDir) {
    const entries = String(currentPath || '').split(path.delimiter).map((item) => item.trim()).filter(Boolean);
    const resolvedBinDir = path.resolve(binDir);
    for (const entry of entries) {
      if (path.resolve(entry) === resolvedBinDir) continue;
      const candidate = path.join(entry, tool);
      try {
        const stat = fs.statSync(candidate);
        if (stat && stat.isFile && stat.isFile()) return candidate;
      } catch (_error) {}
    }
    return '';
  }

  function installSshClipboardCommandShims(envOverrides, options = {}) {
    if (!shouldEnableSshClipboardCommandShims()) return;
    const selectedId = String(options.id || '').trim();
    const sessionKey = buildSshClipboardSessionKey({
      env: processObj.env,
      cwd: processObj.cwd(),
      provider: options.cliName,
      cliAccountId: selectedId,
      pid: processObj.pid
    });
    const inbox = createSshClipboardInbox({
      fs,
      sessionKey,
      maxBytes: Number(processObj.env.AIH_SSH_CLIP_MAX_BYTES) || undefined
    });
    const shimRoot = path.join(inbox.rootDir, 'shim');
    const responseRoot = path.join(shimRoot, 'responses');
    const binDir = resolveAihRunPath(aiHomeDir, 'shims', 'ssh-clipboard');
    try {
      fs.mkdirSync(responseRoot, { recursive: true });
    } catch (_error) {
      return;
    }
    if (!ensureSshClipboardShimBin(binDir)) return;
    const envPathKey = processObj.platform === 'win32' ? 'Path' : 'PATH';
    const currentPath = String(envOverrides[envPathKey] || envOverrides.PATH || envOverrides.Path || '');
    envOverrides[envPathKey] = currentPath ? `${binDir}${path.delimiter}${currentPath}` : binDir;
    envOverrides.AIH_SSH_CLIP_SHIM_BIN_DIR = binDir;
    sshClipboardShimTools().forEach((tool) => {
      const key = realShimToolEnvKey(tool);
      if (!key) return;
      const realPath = resolveRealShimToolPath(tool, currentPath, binDir);
      if (realPath) envOverrides[key] = realPath;
    });
    envOverrides.AIH_SSH_CLIP_SHIM_DIR = shimRoot;
    envOverrides.AIH_SSH_CLIP_SHIM_TIMEOUT_MS = String(Number(processObj.env.AIH_SSH_CLIP_SHIM_TIMEOUT_MS) || DEFAULT_SHIM_TIMEOUT_MS);
    envOverrides.AIH_SSH_CLIP_SHIM_MAX_BYTES = String(Number(processObj.env.AIH_SSH_CLIP_MAX_BYTES) || (16 * 1024 * 1024));
  }

  return {
    installSshClipboardCommandShims
  };
}

module.exports = {
  createSshClipboardShims
};
