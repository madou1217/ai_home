'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createNativeSessionHeadlessChild } = require('../lib/server/native-session-headless-child');

test('structured native stdout and diagnostic stderr stay separate until close', async () => {
  const child = createNativeSessionHeadlessChild({ command: process.execPath, args: ['-e',
    "process.stdout.write(JSON.stringify({type:'result',result:'piped-answer'})+'\\n');process.stderr.write('diagnostic\\n');"]
  }, { provider: 'codebuddy', cwd: process.cwd(), env: process.env });
  let stdout = '', stderr = '';
  child.onData(chunk => { stdout += chunk; });
  child.onErrorData(chunk => { stderr += chunk; });
  const exit = await new Promise(resolve => child.onExit(resolve));
  assert.equal(exit.exitCode, 0);
  assert.equal(JSON.parse(stdout).result, 'piped-answer');
  assert.equal(stderr, 'diagnostic\n');
});

test('Windows Node shims are resolved before stdio spawn and retain verbatim arguments', () => {
  let spawned;
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  createNativeSessionHeadlessChild({ command: 'C:\\tools\\codebuddy.cmd', args: ['--print', 'a prompt with "quotes"'] }, {
    provider: 'codebuddy', platform: 'win32', cwd: 'C:\\project', env: {},
    fs: { existsSync: () => true, readFileSync: () => '@"%~dp0\\node.exe" "%~dp0\\node_modules\\buddy\\cli.js" %*' },
    spawn: (command, args, options) => { spawned = { command, args, options }; return child; }
  });
  assert.equal(spawned.command, 'C:\\tools\\node.exe');
  assert.deepEqual(spawned.args, ['C:\\tools\\node_modules\\buddy\\cli.js', '--print', 'a prompt with "quotes"']);
  assert.deepEqual(spawned.options.stdio, ['ignore', 'pipe', 'pipe']);
  assert.equal(spawned.options.windowsHide, true);
  assert.equal(spawned.options.windowsVerbatimArguments, false, 'node receives structured argv, not a command string');
});
