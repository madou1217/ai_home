'use strict';

const CODEX_DESKTOP_BUNDLE_NAMES = Object.freeze(['ChatGPT.app', 'Codex.app']);
const CODEX_DESKTOP_LAYOUTS = Object.freeze([
  Object.freeze({
    id: 'macos-nested-cli',
    platform: 'darwin',
    hookStrategy: 'external-launcher',
    relativePath: 'Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'
  }),
  Object.freeze({
    id: 'macos-resources',
    platform: 'darwin',
    relativePath: 'Contents/Resources/codex'
  }),
  Object.freeze({
    id: 'windows-store',
    platform: 'win32',
    relativePath: 'app/resources/codex.exe'
  })
]);

function isCodexDesktopBinary(filePath) {
  const normalized = String(filePath || '').replace(/\\/g, '/');
  return CODEX_DESKTOP_LAYOUTS.filter(layout => layout.platform === 'darwin').some(layout => CODEX_DESKTOP_BUNDLE_NAMES.some(bundle => (
    normalized.endsWith(`/${bundle}/${layout.relativePath}`)
  )));
}

module.exports = { CODEX_DESKTOP_BUNDLE_NAMES, CODEX_DESKTOP_LAYOUTS, isCodexDesktopBinary };
