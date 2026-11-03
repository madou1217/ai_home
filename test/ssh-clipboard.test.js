'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { isCtrlVClipboardTrigger } = require('../lib/cli/services/ssh-clipboard/keys');
const { createLocalClipboard } = require('../lib/cli/services/pty/local-clipboard');
const { readClipboardImage } = require('../lib/cli/services/ssh-clipboard/clipboard');
const { runAihSshCommand } = require('../lib/cli/services/ssh-clipboard/ssh-command');

test('recognizes Ctrl+V clipboard shortcuts across terminal keyboard encodings', () => {
  assert.equal(isCtrlVClipboardTrigger('\x16'), true);
  assert.equal(isCtrlVClipboardTrigger('\x1b[118;4u'), true);
  assert.equal(isCtrlVClipboardTrigger('\x1b[27;5;118~'), true);
  assert.equal(isCtrlVClipboardTrigger('v'), false);
});

test('remote PTY treats Ctrl+V as an image paste trigger', () => {
  const clipboard = createLocalClipboard({
    fs: require('node:fs'),
    path: require('node:path'),
    processObj: { platform: 'linux', env: { SSH_CONNECTION: 'client' } },
    isLogin: false,
    isSshRuntimeSession: () => true,
    isInteractiveSession: () => true,
    isCleanedUp: () => false
  });
  assert.equal(clipboard.isClipboardPasteTrigger('\x16'), true);
});

test('Linux clipboard probing bounds stale X11 commands', () => {
  const calls = [];
  const image = readClipboardImage({
    platform: 'linux',
    maxBytes: 1024,
    spawnSync(command, args, options) {
      calls.push({ command, args, options });
      return { status: 1, stdout: Buffer.alloc(0) };
    }
  });
  assert.equal(image, null);
  assert.ok(calls.length >= 2);
  assert.ok(calls.every((call) => call.options.timeout === 800));
});

test('aih ssh swallows an image shortcut when the client clipboard is unavailable', async () => {
  const input = new EventEmitter();
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (value) => { input.isRaw = value; };
  input.resume = () => {};
  input.pause = () => {};
  const output = new EventEmitter();
  output.isTTY = true;
  output.columns = 120;
  output.write = () => true;
  const childInput = { writes: [], write(value) { this.writes.push(value); return true; }, end() {} };
  const child = new EventEmitter();
  child.stdin = childInput;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const processObj = {
    stdin: input,
    stdout: output,
    stderr: output,
    env: {},
    platform: 'linux',
    pid: 123,
    cwd: () => '/tmp'
  };
  const result = runAihSshCommand(['ssh', 'user@example.test'], {
    processObj,
    spawn: () => child,
    spawnSync: () => ({ status: 1, stdout: Buffer.alloc(0) }),
    consoleImpl: { log() {}, error() {} }
  });
  input.emit('data', '\x16');
  assert.deepEqual(childInput.writes, []);
  child.emit('exit', 0, null);
  assert.equal(await result, 0);
});
