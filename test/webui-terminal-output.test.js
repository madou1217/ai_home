'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { openWebUiTerminalSession, handleWebUiTerminalRequest } = require('../lib/server/webui-terminal-routes');
const { replayableTerminalOutput } = require('../lib/server/terminal-replay');

test('tmux snapshots omit stale queries but direct PTYs keep pending queries', () => {
  const buffer = ['\x1b[31mred\x1b[', 'c\x1b[>c\x1b[6n\x1b[18t\x1b[>q\x1b]10;?\x1b\\', '\x1b[0m$ '];
  const output = replayableTerminalOutput({ durable: true, buffer });
  assert.equal(output, '\x1b[31mred\x1b[0m$ ');
  assert.equal(replayableTerminalOutput({ durable: false, buffer }), buffer.join(''));
});

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

test('Web Terminal child receives the scoped runtime marker', { timeout: 5000 }, async () => {
  const muxId = `marker-${process.pid}-${Date.now()}`;
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
  const session = openWebUiTerminalSession({ muxId, file: process.execPath, args: ['-e', "process.stdout.write(process.env.AIH_RUNTIME_MARKER || '')"] });
  assert.equal(session.ok, true);
  try {
    await exited;
    const output = frames.filter((frame) => frame.termId === session.termId && frame.type === 'output')
      .map((frame) => Buffer.from(frame.data, 'base64').toString()).join('');
    assert.match(output, /(?:^|,)web=1(?:,|$)/);
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

test('a direct PTY forwards its pending query on replay and later live queries', { timeout: 10000 }, async () => {
  const muxId = `replay-query-${process.pid}-${Date.now()}`;
  const session = openWebUiTerminalSession({ muxId, file: process.execPath, args: ['-e', "process.stdin.setRawMode(true);process.stdin.once('data', () => { process.stdout.write('LIVE\\x1b[>c', () => process.exit()); });process.stdin.resume();process.stdout.write('SNAPSHOT\\x1b[c');"] });
  assert.equal(session.ok, true);
  const initialReq = new EventEmitter();
  const initialRes = new EventEmitter();
  initialRes.writeHead = () => {};
  let resolveSnapshot;
  const snapshotSeen = new Promise((resolve) => { resolveSnapshot = resolve; });
  let initialOutput = '';
  initialRes.write = (text) => {
    if (text.startsWith('data: ')) {
      const frame = JSON.parse(text.slice(6));
      if (frame.type === 'output') {
        initialOutput += Buffer.from(frame.data, 'base64').toString();
        if (initialOutput.includes('SNAPSHOT')) resolveSnapshot();
      }
    }
    return true;
  };
  await handleWebUiTerminalRequest({ method: 'GET', pathname: '/v0/webui/terminal/stream', url: new URL(`http://localhost/?termId=${session.termId}`), req: initialReq, res: initialRes });
  await snapshotSeen;
  initialReq.emit('close');
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
  try {
    await handleWebUiTerminalRequest({ method: 'POST', pathname: '/v0/webui/terminal/input', req: {}, res: {},
      readRequestBody: async () => Buffer.from(JSON.stringify({ termId: session.termId, data: 'go' })), writeJson: () => {} });
    await exited;
    const output = frames.filter((frame) => frame.termId === session.termId && frame.type === 'output')
      .map((frame) => Buffer.from(frame.data, 'base64').toString()).join('');
    assert.match(output, /SNAPSHOT/);
    assert.equal(output.includes('\x1b[c'), true);
    assert.equal(output.includes('LIVE\x1b[>c'), true);
  } finally {
    req.emit('close');
  }
});
