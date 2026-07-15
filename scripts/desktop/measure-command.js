#!/usr/bin/env node
'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const { parseArgs, requireString } = require('./lib/cli');
const { writeJson } = require('./lib/fs-utils');

function run(command, commandArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      env: process.env,
      stdio: 'inherit',
      windowsHide: false,
    });
    child.once('error', reject);
    child.once('exit', (exitCode, signal) => resolve({ exitCode, signal }));
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const label = requireString(args, 'label');
  const outputPath = requireString(args, 'output');
  if (args._.length === 0) {
    throw new Error('必须在 -- 后提供要执行的命令');
  }

  const [command, ...commandArgs] = args._;
  const startedAt = new Date();
  const startedNs = process.hrtime.bigint();
  let execution = { exitCode: null, signal: null };
  let spawnError = null;

  try {
    execution = await run(command, commandArgs);
  } catch (error) {
    spawnError = error;
  }

  const finishedAt = new Date();
  const durationMs = Number(process.hrtime.bigint() - startedNs) / 1_000_000;
  const success = !spawnError && execution.exitCode === 0;
  writeJson(outputPath, {
    schemaVersion: 1,
    label,
    status: success ? 'passed' : 'failed',
    command: path.basename(command),
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: Math.round(durationMs),
    exitCode: execution.exitCode,
    signal: execution.signal,
    error: spawnError ? spawnError.message : null,
  });

  if (spawnError) {
    throw spawnError;
  }
  if (execution.exitCode !== 0) {
    process.exitCode = execution.exitCode || 1;
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`计时命令失败: ${error.message}\n`);
    process.exitCode = 1;
  });
}
