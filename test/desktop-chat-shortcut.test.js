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
  assert.deepEqual(translationProtocol.normalizeSettingsPatch({ chatShortcut: 'command+option+j' }), { chatShortcut: 'command+option+j' });
  assert.match(registrySource, /chatShortcut/);
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
  assert.match(fs.readFileSync(path.join(root, 'native/chat/ChatPanel.swift'), 'utf8'), /type": "chat\.open/);
  assert.deepEqual(protocol.normalizeDesktopEvent({ type: 'chat.open', requestId: 'shortcut-1', target: { kind: 'aih-server' } }), {
    version: 1, type: 'chat.open', requestId: 'shortcut-1', target: { kind: 'aih-server' }
  });
});

test('macOS build includes desktop shortcut source in source list and fingerprint', () => {
  const source = fs.readFileSync(path.join(root, 'lib/desktop/translation/macos-build.js'), 'utf8');
  const fingerprint = fs.readFileSync(path.join(root, 'lib/server/source-fingerprint.js'), 'utf8');
  assert.match(source, /native\/desktop/);
  assert.match(source, /ShortcutRegistry\.swift/);
  assert.match(fingerprint, /native\/desktop\/ShortcutRegistry\.swift/);
});
