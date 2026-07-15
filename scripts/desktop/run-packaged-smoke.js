#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { parseArgs, requireString } = require('./lib/cli');
const {
  closeFixture,
  requestFixtureSnapshot,
  startFixture,
} = require('./lib/fixture-process');
const {
  displayPath,
  readJson,
  waitForFile,
  writeJson,
} = require('./lib/fs-utils');
const { bootstrapLinuxKeyring } = require('./lib/linux-keyring');
const {
  boundedAppend,
  containsSecret,
  redactText,
  runCaptured,
} = require('./lib/process-utils');
const {
  FIXTURE_PATHS,
  SMOKE_ENVIRONMENT,
  validateApplicationResult,
} = require('./lib/smoke-contract');

function launchApplication(executablePath, environment) {
  const child = spawn(executablePath, [], {
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
  });
  const capture = {
    stdout: '',
    stderr: '',
    exitCode: null,
    signal: null,
  };
  child.stdout.on('data', (chunk) => {
    capture.stdout = boundedAppend(capture.stdout, chunk);
  });
  child.stderr.on('data', (chunk) => {
    capture.stderr = boundedAppend(capture.stderr, chunk);
  });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (exitCode, signal) => {
      capture.exitCode = exitCode;
      capture.signal = signal;
      resolve({ exitCode, signal });
    });
  });
  return { capture, child, exited };
}

async function terminateApplication(application) {
  if (application.capture.exitCode !== null || application.capture.signal !== null) {
    return;
  }
  if (process.platform === 'win32') {
    await runCaptured('taskkill.exe', ['/PID', String(application.child.pid), '/T', '/F']).catch(() => {});
    return;
  }
  application.child.kill('SIGTERM');
  await Promise.race([
    application.exited,
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (application.capture.exitCode === null && application.capture.signal === null) {
    application.child.kill('SIGKILL');
  }
}

function validateFixtureRequests(snapshot) {
  const errors = [];
  const protectedPaths = [FIXTURE_PATHS.json, FIXTURE_PATHS.sse, FIXTURE_PATHS.blob];
  for (const fixturePath of protectedPaths) {
    const requests = snapshot.requests.filter((request) => request.path === fixturePath);
    if (requests.length === 0) {
      errors.push(`fixture 未收到 ${fixturePath} 请求`);
      continue;
    }
    if (requests.some((request) => !request.authorized || request.status !== 200)) {
      errors.push(`fixture 的 ${fixturePath} 请求未全部通过 Management Key 认证`);
    }
  }
  return errors;
}

async function main() {
  const args = parseArgs(process.argv.slice(2), { booleans: ['bootstrap-linux-keyring'] });
  const installManifestPath = requireString(args, 'install-manifest');
  const outputPath = requireString(args, 'output');
  const timeoutMs = args['timeout-ms'] === undefined ? 90_000 : Number(args['timeout-ms']);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 5_000 || timeoutMs > 300_000) {
    throw new Error('--timeout-ms 必须是 5000 到 300000 之间的整数');
  }

  const installManifest = readJson(installManifestPath);
  if (installManifest.status !== 'installed') {
    throw new Error('安装清单不是 installed 状态');
  }
  if (!installManifest.executablePath || !fs.existsSync(installManifest.executablePath)) {
    throw new Error('安装清单中的可执行文件不存在');
  }

  const runId = crypto.randomUUID();
  const managementKey = `desktop-smoke-${crypto.randomBytes(32).toString('hex')}`;
  const applicationResultPath = path.resolve(`${outputPath}.application.json`);
  fs.rmSync(applicationResultPath, { force: true });
  const startedAt = new Date();
  const startedNs = process.hrtime.bigint();
  const evidence = {
    schemaVersion: 1,
    status: 'failed',
    runId,
    platform: process.platform,
    architecture: process.arch,
    bundleKind: installManifest.kind,
    distributionSigning: installManifest.distributionSigning,
    startedAt: startedAt.toISOString(),
    finishedAt: null,
    durationMs: null,
    keyringPreflight: {
      status: args['bootstrap-linux-keyring'] ? 'pending' : 'application-verified',
    },
    fixture: {
      requests: [],
    },
    application: {
      result: null,
      exitCode: null,
      signal: null,
      stdoutBytes: 0,
      stderrBytes: 0,
    },
    secretLeakScan: {
      status: 'pending',
    },
    errors: [],
  };
  let fixture = null;
  let application = null;

  try {
    let applicationEnvironment = { ...process.env };
    if (args['bootstrap-linux-keyring']) {
      applicationEnvironment = await bootstrapLinuxKeyring(applicationEnvironment);
      evidence.keyringPreflight.status = 'passed';
    }

    fixture = startFixture({
      fixtureServerPath: path.join(__dirname, 'fixture-server.js'),
      runId,
      managementKey,
    });
    const fixtureReady = await fixture.ready;
    applicationEnvironment = {
      ...applicationEnvironment,
      [SMOKE_ENVIRONMENT.mode]: '1',
      [SMOKE_ENVIRONMENT.runId]: runId,
      [SMOKE_ENVIRONMENT.serverUrl]: fixtureReady.baseUrl,
      [SMOKE_ENVIRONMENT.managementKey]: managementKey,
      [SMOKE_ENVIRONMENT.resultPath]: applicationResultPath,
    };
    application = launchApplication(installManifest.executablePath, applicationEnvironment);

    await Promise.race([
      waitForFile(applicationResultPath, { timeoutMs }),
      application.exited.then(() => {
        if (!fs.existsSync(applicationResultPath)) {
          throw new Error('packaged 应用在写入 smoke 结果前退出');
        }
      }),
    ]);

    const rawApplicationResult = fs.readFileSync(applicationResultPath, 'utf8');
    if (containsSecret(rawApplicationResult, managementKey)) {
      fs.rmSync(applicationResultPath, { force: true });
      throw new Error('packaged 应用结果包含测试 Management Key，已拒绝并删除该结果');
    }
    const applicationResult = JSON.parse(rawApplicationResult);
    evidence.application.result = applicationResult;
    evidence.errors.push(...validateApplicationResult(applicationResult, {
      platform: process.platform,
      runId,
    }));

    const fixtureSnapshot = await requestFixtureSnapshot(fixture.child);
    evidence.fixture.requests = fixtureSnapshot.requests;
    evidence.errors.push(...validateFixtureRequests(fixtureSnapshot));
  } catch (error) {
    evidence.errors.push(redactText(error.message, managementKey));
  } finally {
    if (application) {
      await terminateApplication(application);
      evidence.application.exitCode = application.capture.exitCode;
      evidence.application.signal = application.capture.signal;
      evidence.application.stdoutBytes = Buffer.byteLength(application.capture.stdout, 'utf8');
      evidence.application.stderrBytes = Buffer.byteLength(application.capture.stderr, 'utf8');
      if (
        containsSecret(application.capture.stdout, managementKey)
        || containsSecret(application.capture.stderr, managementKey)
      ) {
        evidence.errors.push('packaged 应用输出包含测试 Management Key，输出内容已丢弃');
      }
    }
    if (fixture) {
      const fixtureOutput = fixture.output();
      if (fixtureOutput.stdout.trim()) {
        evidence.errors.push('fixture 产生了非预期 stdout，内容已丢弃');
      }
      if (fixtureOutput.stderr.trim()) {
        evidence.errors.push('fixture 产生了非预期 stderr，内容已丢弃');
      }
      await closeFixture(fixture.child);
    }

    const serializedEvidence = JSON.stringify(evidence);
    evidence.secretLeakScan.status = containsSecret(serializedEvidence, managementKey) ? 'failed' : 'passed';
    if (evidence.secretLeakScan.status === 'failed') {
      evidence.application.result = null;
      evidence.errors = ['smoke evidence 包含测试密钥，敏感字段已全部丢弃'];
    }
    evidence.status = evidence.errors.length === 0 && evidence.secretLeakScan.status === 'passed'
      ? 'passed'
      : 'failed';
    evidence.finishedAt = new Date().toISOString();
    evidence.durationMs = Math.round(Number(process.hrtime.bigint() - startedNs) / 1_000_000);
    writeJson(outputPath, evidence);
  }

  if (evidence.status !== 'passed') {
    throw new Error(`packaged smoke 未通过，详见 ${displayPath(outputPath)}`);
  }
  process.stdout.write(`packaged smoke 通过，证据: ${displayPath(outputPath)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  validateFixtureRequests,
};
