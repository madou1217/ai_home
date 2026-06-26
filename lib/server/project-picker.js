'use strict';

const path = require('node:path');
const { execFileSync } = require('node:child_process');

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeChosenPath(targetPath) {
  const normalized = normalizeString(targetPath).replace(/\/+$/, '');
  if (!normalized) return '';
  return normalized;
}

function escapeAppleScript(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}

function pickDirectoryWithAppleScript(promptText) {
  const script = [
    'try',
    `set chosenFolder to choose folder with prompt "${escapeAppleScript(promptText)}"`,
    'return POSIX path of chosenFolder',
    'on error number -128',
    'return ""',
    'end try'
  ];
  const output = execFileSync('osascript', script.flatMap((line) => ['-e', line]), {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return normalizeChosenPath(output);
}

function pickDirectoryWithPowerShell(promptText) {
  const message = String(promptText || '').replace(/'/g, "''");
  const command = [
    'Add-Type -AssemblyName System.Windows.Forms;',
    '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog;',
    `$dialog.Description = '${message}';`,
    '$dialog.UseDescriptionForTitle = $true;',
    "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {",
    '  [Console]::Write($dialog.SelectedPath)',
    '}'
  ].join(' ');
  const output = execFileSync('powershell.exe', ['-NoProfile', '-STA', '-Command', command], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return normalizeChosenPath(output);
}

function pickProjectDirectory(options = {}) {
  const platform = normalizeString(options.platform || process.platform) || process.platform;
  const prompt = normalizeString(options.prompt) || '请选择要打开的项目文件夹';

  try {
    if (platform === 'darwin') {
      const pickedPath = pickDirectoryWithAppleScript(prompt);
      return pickedPath ? { path: pickedPath, name: path.basename(pickedPath) } : null;
    }
    if (platform === 'win32') {
      const pickedPath = pickDirectoryWithPowerShell(prompt);
      return pickedPath ? { path: pickedPath, name: path.basename(pickedPath) } : null;
    }
  } catch (error) {
    const nextError = new Error(String((error && error.message) || error || 'project_picker_failed'));
    nextError.code = 'project_picker_failed';
    throw nextError;
  }

  const unsupported = new Error('project_picker_unsupported_platform');
  unsupported.code = 'project_picker_unsupported_platform';
  throw unsupported;
}

module.exports = {
  normalizeChosenPath,
  pickProjectDirectory
};
