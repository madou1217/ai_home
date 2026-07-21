#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const TEST_TEMP_PREFIX = 'aih-test-run-';
const SIGNAL_EXIT_CODES = Object.freeze({ SIGINT: 130, SIGTERM: 143 });

function createTestTempRoot(options = {}) {
  const fsImpl = options.fs || fs;
  const baseDir = path.resolve(options.baseDir || os.tmpdir());
  return fsImpl.mkdtempSync(path.join(baseDir, TEST_TEMP_PREFIX));
}

function removeTestTempRoot(rootDir, options = {}) {
  const fsImpl = options.fs || fs;
  const resolved = path.resolve(String(rootDir || ''));
  if (!path.basename(resolved).startsWith(TEST_TEMP_PREFIX)) {
    throw new Error('unsafe_test_temp_root');
  }
  fsImpl.rmSync(resolved, { recursive: true, force: true });
}

function buildTestEnv(rootDir, baseEnv = process.env) {
  return {
    ...baseEnv,
    TMPDIR: rootDir,
    TMP: rootDir,
    TEMP: rootDir
  };
}

function listTestFiles(projectRoot, options = {}) {
  const fsImpl = options.fs || fs;
  const testDir = path.join(projectRoot, 'test');
  return fsImpl.readdirSync(testDir)
    .filter((fileName) => fileName.endsWith('.test.js'))
    .sort()
    .map((fileName) => path.join('test', fileName));
}

function run(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || path.join(__dirname, '..'));
  const testFiles = listTestFiles(projectRoot, options);
  const tempRoot = createTestTempRoot(options);
  let child;
  try {
    child = (options.spawn || spawn)(
      options.execPath || process.execPath,
      ['--test', ...testFiles],
      {
        cwd: projectRoot,
        env: buildTestEnv(tempRoot, options.env || process.env),
        stdio: 'inherit'
      }
    );
  } catch (error) {
    removeTestTempRoot(tempRoot, options);
    throw error;
  }

  return new Promise((resolve) => {
    let settled = false;
    let receivedSignal = '';
    const signalHandlers = new Map();

    const cleanup = () => {
      removeTestTempRoot(tempRoot, options);
      for (const [signal, handler] of signalHandlers) {
        process.removeListener(signal, handler);
      }
    };
    const finish = (code, signal = '') => {
      if (settled) return;
      settled = true;
      cleanup();
      const effectiveSignal = receivedSignal || signal;
      resolve(effectiveSignal ? SIGNAL_EXIT_CODES[effectiveSignal] || 1 : Number(code) || 0);
    };

    for (const signal of Object.keys(SIGNAL_EXIT_CODES)) {
      const handler = () => {
        receivedSignal = signal;
        if (child.exitCode === null && child.signalCode === null) child.kill(signal);
      };
      signalHandlers.set(signal, handler);
      process.once(signal, handler);
    }

    child.once('error', () => finish(1));
    child.once('exit', finish);
  });
}

if (require.main === module) {
  run().then((exitCode) => {
    process.exitCode = exitCode;
  }, (error) => {
    process.stderr.write(`[aih-test-runner] ${String(error && error.message || error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  TEST_TEMP_PREFIX,
  buildTestEnv,
  createTestTempRoot,
  listTestFiles,
  removeTestTempRoot,
  run
};
