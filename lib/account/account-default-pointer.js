'use strict';

const {
  clearDefaultAccountRef,
  readDefaultAccountRef
} = require('./default-account-store');
const { createCodexDesktopHookService } = require('../server/codex-desktop-hook');

// Shared cleanup for the "default account" / codex "mobile (desktop) account"
// pointers. Both pointers persist accountRef, so reusing a CLI number can never
// redirect a stale pointer to another account.

function clearDefaultPointerIfNeeded(fs, aiHomeDir, provider, accountRef) {
  const expectedRef = String(accountRef || '').trim();
  if (!fs || !aiHomeDir || !provider || !expectedRef) return false;
  if (readDefaultAccountRef(fs, aiHomeDir, provider) !== expectedRef) return false;
  return clearDefaultAccountRef(fs, aiHomeDir, provider, expectedRef);
}

function clearCodexMobilePointerIfNeeded(fs, aiHomeDir, accountRef, options = {}) {
  const expectedRef = String(accountRef || '').trim();
  if (!fs || !aiHomeDir || !expectedRef) return false;
  const service = createCodexDesktopHookService({
    fs,
    path: options.path,
    processObj: options.processObj,
    aiHomeDir,
    hostHomeDir: options.hostHomeDir
  });
  if (service.getDesktopAccountRef() !== expectedRef) return false;
  const result = service.clearDesktopAccountRef(expectedRef);
  return Boolean(result && result.ok && result.changed);
}

// Clears every dangling default pointer that referenced the deleted account.
// Safe to call for any provider; the codex mobile pointer is only touched for
// provider === 'codex'.
function clearDanglingAccountPointers(options = {}) {
  const { fs, aiHomeDir, provider, accountRef } = options;
  const clearedDefault = clearDefaultPointerIfNeeded(fs, aiHomeDir, provider, accountRef);
  const clearedMobile = provider === 'codex'
    ? clearCodexMobilePointerIfNeeded(fs, aiHomeDir, accountRef, options)
    : false;
  return { clearedDefault, clearedMobile };
}

module.exports = {
  clearDefaultPointerIfNeeded,
  clearCodexMobilePointerIfNeeded,
  clearDanglingAccountPointers
};
