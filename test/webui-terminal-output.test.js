'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { openWebUiTerminalSession, handleWebUiTerminalRequest } = require('../lib/server/webui-terminal-routes');

test('PTY mux preserves burst output before exit', { timeout: 5000 }, async () => {
  const muxId = `test-${process.pid}-${Date.now()}`;
  const req = new EventEmitter();
  const res = new EventEmitter();
  res.writeHead = () => {};
  const frames = [];
  let resolveExit;
  const exited = new Promise((resolve) => { resolveExit = resolve; });
  res.write = (text) => {
    if (!text.startsWith('data: ')) return true;
    const frame = JSON.parse(text.slice(6));
    frames.push(frame);
    if (frame.type === 'exit') resolveExit();
    return true;
  };
  await handleWebUiTerminalRequest({ method: 'GET', pathname: '/v0/webui/terminal/mux', url: new URL(`http://localhost/?muxId=${muxId}`), req, res });
  const session = openWebUiTerminalSession({ muxId, file: process.execPath, args: ['-e', "for(let i=0;i<200;i++)process.stdout.write('x');process.stdout.write('END')"] });
  assert.equal(session.ok, true);
  try {
    await exited;
    const relevant = frames.filter((frame) => frame.termId === session.termId);
    const output = relevant.filter((frame) => frame.type === 'output').map((frame) => Buffer.from(frame.data, 'base64').toString()).join('');
    assert.equal(output, `${'x'.repeat(200)}END`);
    assert.equal(relevant.at(-1).type, 'exit');
  } finally {
    req.emit('close');
  }
});

test('a late close from an old mux cannot disconnect the replacement stream', { timeout: 5000 }, async () => {
  const muxId = `reconnect-${process.pid}-${Date.now()}`;
  const connect = async () => {
    const req = new EventEmitter();
    const res = new EventEmitter();
    res.writeHead = () => {};
    const frames = [];
    let resolveExit;
    const exited = new Promise((resolve) => { resolveExit = resolve; });
    res.write = (text) => {
      if (text.startsWith('data: ')) {
        const frame = JSON.parse(text.slice(6));
        frames.push(frame);
        if (frame.type === 'exit') resolveExit();
      }
      return true;
    };
    await handleWebUiTerminalRequest({ method: 'GET', pathname: '/v0/webui/terminal/mux', url: new URL(`http://localhost/?muxId=${muxId}`), req, res });
    return { req, res, frames, exited };
  };
  const first = await connect();
  const session = openWebUiTerminalSession({ muxId, file: process.execPath, args: ['-e', "setTimeout(() => console.log('AFTER_RECONNECT'), 200)"] });
  assert.equal(session.ok, true);
  first.req.emit('close');
  const second = await connect();
  try {
    first.res.emit('close'); // A delayed second event for the old connection.
    await second.exited;
    const output = second.frames.filter((frame) => frame.termId === session.termId && frame.type === 'output')
      .map((frame) => Buffer.from(frame.data, 'base64').toString()).join('');
    assert.match(output, /AFTER_RECONNECT/);
  } finally {
    second.req.emit('close');
  }
});
