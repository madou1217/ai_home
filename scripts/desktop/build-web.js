#!/usr/bin/env node
'use strict';

const { sync: spawnSync } = require('cross-spawn');

const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor !== 20 && nodeMajor !== 22) {
  throw new Error(
    `Desktop Web 构建仅支持 Node 20/22；当前为 ${process.versions.node}。`
  );
}

const result = spawnSync('npm', ['run', 'build'], {
  cwd: require('node:path').resolve(__dirname, '../../web'),
  env: {
    ...process.env,
    AIH_DESKTOP_BUILD: '1',
  },
  stdio: 'inherit',
});

if (result.error) throw result.error;
process.exitCode = result.status === null ? 1 : result.status;
