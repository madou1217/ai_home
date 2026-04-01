#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

function ensureExecutable(filePath) {
  try {
    if (!fs.existsSync(filePath)) return;
    fs.chmodSync(filePath, 0o755);
  } catch (err) {
    // Best effort only: do not fail installation for permission tweaks.
  }
}

function fixStalePreCommitHook(rootDir) {
  const hookPath = path.join(rootDir, '.git', 'hooks', 'pre-commit');
  if (!fs.existsSync(hookPath)) return;

  let hookBody = '';
  try {
    hookBody = fs.readFileSync(hookPath, 'utf8');
  } catch (err) {
    return;
  }

  const nodeScriptMatch = hookBody.match(/^\s*node\s+([^\s]+)\s*$/m);
  if (!nodeScriptMatch) return;

  const rawScriptPath = nodeScriptMatch[1].trim();
  const scriptPath = path.resolve(rootDir, rawScriptPath);
  if (fs.existsSync(scriptPath)) return;

  const safeHook = [
    '#!/bin/sh',
    '# reset stale hook entry whose target script is missing',
    'exit 0',
    ''
  ].join('\n');
  try {
    fs.writeFileSync(hookPath, safeHook, 'utf8');
    fs.chmodSync(hookPath, 0o755);
  } catch (err) {
    // Best effort only: do not fail installation for hook cleanup.
  }
}

function main() {
  const rootDir = path.resolve(__dirname, '..');
  fixStalePreCommitHook(rootDir);

  if (process.platform !== 'darwin') return;
  const helpers = [
    path.join(rootDir, 'node_modules', 'node-pty', 'prebuilds', 'darwin-x64', 'spawn-helper'),
    path.join(rootDir, 'node_modules', 'node-pty', 'prebuilds', 'darwin-arm64', 'spawn-helper')
  ];

  helpers.forEach(ensureExecutable);
}

main();
