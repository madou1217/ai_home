'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  CLAUDE_WINDOWS_INSTALL_URL,
  collectNativeCliPathEntries,
  resolveNativeCliInstallPlans
} = require('../lib/cli/services/ai-cli/native-cli-installer');

test('Windows Claude prefers the official native installer before npm fallback', () => {
  const plans = resolveNativeCliInstallPlans('claude', '@anthropic-ai/claude-code', {
    path,
    processObj: {
      platform: 'win32',
      env: { SystemRoot: 'C:\\Windows' }
    },
    resolveNpmInstall: () => ({ command: 'npm.cmd', args: ['install', '-g', '@anthropic-ai/claude-code'] })
  });

  assert.equal(plans.length, 2);
  assert.equal(plans[0].id, 'claude_windows_native');
  assert.equal(plans[0].command, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.match(plans[0].args.at(-1), new RegExp(CLAUDE_WINDOWS_INSTALL_URL.replaceAll('.', '\\.')));
  assert.equal(plans[0].timeoutMs, 300000);
  assert.equal(plans[1].id, 'npm_global');
});

test('non-Windows providers keep the existing npm-only install path', () => {
  const plans = resolveNativeCliInstallPlans('claude', '@anthropic-ai/claude-code', {
    path,
    processObj: { platform: 'linux', env: {} },
    resolveNpmInstall: () => ({ command: 'npm', args: ['install', '-g', '@anthropic-ai/claude-code'] })
  });

  assert.deepEqual(plans, [{
    id: 'npm_global',
    label: 'npm global installer',
    command: 'npm',
    args: ['install', '-g', '@anthropic-ai/claude-code'],
    timeoutMs: 120000
  }]);
});

test('Windows Claude lookup includes the official native install directory only for Claude', () => {
  const options = {
    path,
    hostHomeDir: 'C:\\Users\\example',
    processObj: { platform: 'win32' }
  };
  assert.deepEqual(
    collectNativeCliPathEntries('claude', options),
    ['C:\\Users\\example\\.local\\bin']
  );
  assert.deepEqual(collectNativeCliPathEntries('codex', options), []);
  assert.deepEqual(collectNativeCliPathEntries('claude', {
    ...options,
    processObj: { platform: 'linux' }
  }), []);
});

test('Qoder install plans use region-specific official installers', () => {
  const winGlobal = resolveNativeCliInstallPlans('qoder', '@qoder-ai/qodercli', {
    path,
    hostHomeDir: 'C:\\Users\\example',
    processObj: { platform: 'win32', env: { SystemRoot: 'C:\\Windows' } },
    resolveNpmInstall: () => ({ command: 'npm.cmd', args: ['install', '-g', '@qoder-ai/qodercli'] })
  });
  assert.equal(winGlobal[0].id, 'qoder_global_windows_direct');
  assert.match(winGlobal[0].args.at(-1), /qodercli|install --force|manifest/);

  const posixCn = resolveNativeCliInstallPlans('qodercn', '', {
    path,
    hostHomeDir: '/Users/u',
    processObj: { platform: 'darwin', env: {} }
  });
  assert.ok(posixCn.length >= 1);
  assert.equal(posixCn[0].id, 'qoder_cn_posix_script');

  const qoderCnEntries = collectNativeCliPathEntries('qodercn', {
    path,
    hostHomeDir: 'C:\\Users\\example',
    processObj: {
      platform: 'win32',
      env: {
        LOCALAPPDATA: 'C:\\Users\\example\\AppData\\Local',
        ProgramFiles: 'C:\\Program Files',
        'ProgramFiles(x86)': 'C:\\Program Files (x86)'
      }
    }
  });
  assert.ok(qoderCnEntries.includes(path.join('C:\\Users\\example', '.local', 'bin')));
  assert.ok(qoderCnEntries.includes(path.join('C:\\Users\\example', '.qoder-cn', 'bin', 'qoderclicn')));
});

test('Grok uses the official installer and user-level binary directory', () => {
  const options = {
    path,
    hostHomeDir: 'C:\\Users\\test',
    processObj: { platform: 'win32', env: {} }
  };
  const plans = resolveNativeCliInstallPlans('grok', '', options);
  assert.equal(plans.length, 1);
  assert.equal(plans[0].id, 'grok_windows_official');
  assert.match(plans[0].args.join(' '), /https:\/\/x\.ai\/cli\/install\.ps1/);
  assert.deepEqual(collectNativeCliPathEntries('grok', options), [
    path.join(options.hostHomeDir, '.grok', 'bin')
  ]);
});
