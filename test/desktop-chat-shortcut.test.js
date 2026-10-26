'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const protocol = require('../lib/desktop/runtime/desktop-protocol');
const translationProtocol = require('../lib/desktop/translation/protocol');
const build = require('../lib/desktop/translation/macos-build');

const root = path.resolve(__dirname, '..');
const registrySource = fs.readFileSync(path.join(root, 'native/desktop/ShortcutRegistry.swift'), 'utf8');

test('Chat shortcut has an explicit conflict-safe default and descriptor registry', () => {
  assert.match(registrySource, /defaultChatShortcut\s*=\s*"⌘⌥C"/);
  assert.match(registrySource, /ShortcutDescriptor/);
  assert.match(registrySource, /translation/);
  assert.match(registrySource, /chat/);
});

test('user-configured Chat shortcut is carried through configure and settings boundaries', () => {
  assert.deepEqual(protocol.normalizeDesktopEvent({ type: 'configure', chatShortcut: '⌘⌥J' }).chatShortcut, '⌘⌥J');
  assert.deepEqual(translationProtocol.normalizeSettingsPatch({ chatShortcut: 'command+option+j', shortcutEnabled: false, chatShortcutEnabled: false }), { chatShortcut: 'command+option+j', shortcutEnabled: false, chatShortcutEnabled: false });
  assert.deepEqual(require('../lib/account/translation-settings-store').normalizeTranslationSettings({}).shortcutEnabled, true);
  assert.deepEqual(require('../lib/account/translation-settings-store').normalizeTranslationSettings({}).chatShortcutEnabled, true);
  assert.match(registrySource, /chatShortcut/);
});

test('shortcut registration errors are visible in the settings window and full-app Chat reports no runtime', () => {
  const settings = fs.readFileSync(path.join(root, 'native/translation/TranslationSettingsWindow.swift'), 'utf8');
  const content = fs.readFileSync(path.join(root, 'native/translation/TranslationPanelContent.swift'), 'utf8');
  const service = fs.readFileSync(path.join(root, 'lib/desktop/translation/service.js'), 'utf8');
  assert.match(settings, /shortcutStatus/);
  assert.match(settings, /shortcutEnabled/);
  assert.match(content, /settingsWindow\?\.setShortcutStatus/);
  assert.match(service, /chat_runtime_unavailable/);
  assert.match(service, /当前桌面模式没有可用的 Chat Runtime/);
});

test('shortcut conflicts and disabled descriptors are reported without replacing host right-click', () => {
  assert.match(registrySource, /conflict/);
  assert.match(registrySource, /enabled/);
  assert.match(registrySource, /addGlobalMonitorForEvents/);
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'native/translation/main.swift'), 'utf8'), /rightMouseUp[\s\S]{0,500}return nil/);
});

test('Chat shortcut opens through the existing chat.open shell command', () => {
  const main = fs.readFileSync(path.join(root, 'native/translation/main.swift'), 'utf8');
  assert.match(main, /chatPanel\.openFromShortcut\(\)/);
  assert.match(main, /chatSelectedText/);
  assert.match(main, /openFromService\(text: raw\)/);
  assert.match(fs.readFileSync(path.join(root, 'native/chat/ChatPanel.swift'), 'utf8'), /type": "chat\.open/);
  assert.match(fs.readFileSync(path.join(root, 'native/chat/ChatPanel.swift'), 'utf8'), /submitPendingServiceTextIfReady/);
  assert.deepEqual(protocol.normalizeDesktopEvent({ type: 'chat.open', requestId: 'shortcut-1', target: { kind: 'aih-server' } }), {
    version: 1, type: 'chat.open', requestId: 'shortcut-1', target: { kind: 'aih-server' }
  });
});

test('macOS build includes desktop shortcut source in source list and fingerprint', () => {
  const source = fs.readFileSync(path.join(root, 'lib/desktop/translation/macos-build.js'), 'utf8');
  const fingerprint = fs.readFileSync(path.join(root, 'lib/server/source-fingerprint.js'), 'utf8');
  assert.match(source, /native\/desktop/);
  assert.match(source, /ShortcutRegistry\.swift/);
  assert.match(source, /AIH Chat 选中内容/);
  assert.match(source, /chatSelectedText/);
  assert.match(source, /NSServices/);
  assert.match(fingerprint, /native\/desktop\/ShortcutRegistry\.swift/);
});

test('macOS Services registration refreshes LaunchServices and PBS after helper rebuilds', async () => {
  const calls = [];
  await build.registerMacTranslationServices('/tmp/AIH Translation.app', {
    homeDir: '/Users/tester',
    runImpl: async (command, args) => {
      calls.push({ command, args });
    }
  });
  assert.deepEqual(calls, [
    {
      command: '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister',
      args: ['-u', '/Users/tester/Applications/AIH Translation.app']
    },
    {
      command: '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister',
      args: ['-f', '/tmp/AIH Translation.app']
    },
    {
      command: '/System/Library/CoreServices/pbs',
      args: ['-update']
    }
  ]);
});

test('macOS Services registration tolerates an already-removed legacy bundle', async () => {
  const calls = [];
  await build.registerMacTranslationServices('/tmp/AIH Translation.app', {
    homeDir: '/Users/tester',
    runImpl: async (command, args) => {
      calls.push({ command, args });
      if (args[0] === '-u') throw new Error('legacy_bundle_missing');
    }
  });
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[1].args, ['-f', '/tmp/AIH Translation.app']);
  assert.deepEqual(calls[2].args, ['-update']);
});

test('native Chat surface follows the WebUI conversation and composer language', () => {
  const source = fs.readFileSync(path.join(root, 'native/chat/ChatPanelContent.swift'), 'utf8');
  assert.match(source, /final class ChatMessageRow/);
  assert.match(source, /NSTextViewDelegate/);
  assert.match(source, /func textDidChange/);
  assert.match(source, /hasMarkedText\(\)/);
  assert.match(source, /mount\(scroll\)/);
  assert.match(source, /placeholderLabel/);
  assert.match(source, /正在连接/);
  assert.match(source, /正在回复/);
  assert.match(source, /ChatPanelState/);
  assert.match(source, /accessibilityDisplayShouldReduceMotion/);
  assert.match(source, /NSVisualEffectView/);
});
