#!/usr/bin/env node
'use strict';

const spawn = require('cross-spawn');
const path = require('node:path');

const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor !== 20 && nodeMajor !== 22) {
  throw new Error(
    `Desktop Web 开发模式仅支持 Node 20/22；当前为 ${process.versions.node}。`
  );
}

const child = spawn('npm', ['run', 'dev'], {
  cwd: path.resolve(__dirname, '../../web'),
  env: {
    ...process.env,
    AIH_DESKTOP_BUILD: '1',
  },
  stdio: 'inherit',
});

child.once('error', (error) => {
  throw error;
});
child.once('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code === null ? 1 : code;
});
