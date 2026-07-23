'use strict';

const { spawn } = require('node:child_process');
const { readDefaultAccountRef } = require('../account/default-account-store');
const { readAccountCredentialRecord } = require('./account-credential-store');
const { resolveAiHomeDir } = require('./codex-desktop-account');

function buildCodexDefaultCliEnv(fs, options = {}) {
  const processObj = options.processObj || process;
  const env = {
    ...((processObj && processObj.env) || process.env)
  };
  const aiHomeDir = String(options.aiHomeDir || resolveAiHomeDir({
    processObj,
    os: options.os
  }) || '').trim();
  if (!aiHomeDir) {
    return { env, accountRef: '', authMode: 'passthrough' };
  }

  const accountRef = readDefaultAccountRef(fs, aiHomeDir, 'codex');
  if (!accountRef) {
    return { env, accountRef: '', authMode: 'passthrough' };
  }

  const record = readAccountCredentialRecord(fs, aiHomeDir, accountRef);
  const apiKey = record && record.provider === 'codex'
    ? String(record.env && record.env.OPENAI_API_KEY || '').trim()
    : '';
  if (apiKey) {
    env.OPENAI_API_KEY = apiKey;
    return { env, accountRef, authMode: 'apikey' };
  }

  // OAuth uses the host auth.json projected by `aih codex set-default`.
  // Never let an unrelated shell-level API key override that durable choice.
  delete env.OPENAI_API_KEY;
  return {
    env,
    accountRef,
    authMode: record && record.provider === 'codex' ? 'oauth' : 'unavailable'
  };
}

function forwardChildExit(child, processObj) {
  child.on('exit', (code, signal) => {
    if (signal) {
      try {
        processObj.kill(processObj.pid, signal);
        return;
      } catch (_error) {}
    }
    const exitCode = Number(code);
    processObj.exit(Number.isFinite(exitCode) ? exitCode : 0);
  });
}

function runCodexDefaultCli(upstream, args, options = {}) {
  const upstreamBinary = String(upstream || '').trim();
  if (!upstreamBinary) throw new Error('missing_upstream_binary');

  const fs = options.fs || require('node:fs');
  const processObj = options.processObj || process;
  const spawnImpl = options.spawn || spawn;
  const runtime = buildCodexDefaultCliEnv(fs, { ...options, processObj });
  const child = spawnImpl(upstreamBinary, Array.isArray(args) ? args : [], {
    stdio: 'inherit',
    env: runtime.env
  });
  child.on('error', (error) => {
    processObj.stderr.write(`${String((error && error.message) || error || 'codex_launch_failed')}\n`);
    processObj.exit(1);
  });
  forwardChildExit(child, processObj);
  return child;
}

module.exports = {
  buildCodexDefaultCliEnv,
  runCodexDefaultCli
};
