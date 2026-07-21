'use strict';

const { fork } = require('node:child_process');
const { boundedAppend } = require('./process-utils');

function startFixture(options) {
  const child = fork(options.fixtureServerPath, [], {
    env: {
      ...process.env,
      AIH_DESKTOP_FIXTURE_RUN_ID: options.runId,
      AIH_DESKTOP_FIXTURE_MANAGEMENT_KEY: options.managementKey,
    },
    silent: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout = boundedAppend(stdout, chunk);
  });
  child.stderr.on('data', (chunk) => {
    stderr = boundedAppend(stderr, chunk);
  });

  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('fixture 启动超时')), 15_000);
    const onMessage = (message) => {
      if (message?.type === 'ready') {
        clearTimeout(timeout);
        child.off('exit', onExit);
        child.off('message', onMessage);
        resolve(message);
      }
    };
    const onExit = (exitCode, signal) => {
      clearTimeout(timeout);
      child.off('message', onMessage);
      reject(new Error(`fixture 提前退出: code=${exitCode}, signal=${signal}`));
    };
    child.on('message', onMessage);
    child.once('exit', onExit);
  });

  return {
    child,
    ready,
    output: () => ({ stdout, stderr }),
  };
}

function requestFixtureSnapshot(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.off('message', onMessage);
      reject(new Error('fixture snapshot 超时'));
    }, 5_000);
    const onMessage = (message) => {
      if (message?.type === 'snapshot') {
        clearTimeout(timeout);
        child.off('message', onMessage);
        resolve(message);
      }
    };
    child.on('message', onMessage);
    child.send({ type: 'snapshot' }, (error) => {
      if (error) {
        clearTimeout(timeout);
        child.off('message', onMessage);
        reject(error);
      }
    });
  });
}

function closeFixture(child) {
  if (!child.connected) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 5_000);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
    child.send({ type: 'close' }, () => {});
  });
}

module.exports = {
  closeFixture,
  requestFixtureSnapshot,
  startFixture,
};
