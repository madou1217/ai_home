#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { optionalList, parseArgs, requireString } = require('./lib/cli');
const {
  describeDigest,
  displayPath,
  findFiles,
  readJson,
  writeJson,
} = require('./lib/fs-utils');

const SUPPORTED_KINDS = new Set(['app', 'appimage', 'deb', 'dmg', 'msi']);

function artifactMatches(filePath, stat, kind) {
  const lowerPath = filePath.toLowerCase();
  if (kind === 'app') {
    return stat.isDirectory() && lowerPath.endsWith('.app');
  }
  if (!stat.isFile()) {
    return false;
  }
  const extensions = {
    appimage: '.appimage',
    deb: '.deb',
    dmg: '.dmg',
    msi: '.msi',
  };
  return lowerPath.endsWith(extensions[kind]);
}

function loadEvidenceFile(filePath, label, errors) {
  if (!fs.existsSync(filePath)) {
    errors.push(`${label} 缺失: ${displayPath(filePath)}`);
    return null;
  }
  try {
    return readJson(filePath);
  } catch (error) {
    errors.push(`${label} 不是有效 JSON: ${displayPath(filePath)} (${error.message})`);
    return null;
  }
}

function containsSensitiveMaterial(value) {
  const serialized = JSON.stringify(value);
  return /Bearer\s+(?!\[REDACTED\])[^\s"']+/iu.test(serialized)
    || /"(?:managementKey|management_key|AIH_DESKTOP_SMOKE_MANAGEMENT_KEY)"\s*:/iu.test(serialized);
}

function collectArtifacts(bundleRoot, requiredKinds, signingStatus, errors) {
  const artifacts = [];
  for (const kind of requiredKinds) {
    if (!SUPPORTED_KINDS.has(kind)) {
      errors.push(`不支持的 required-kind: ${kind}`);
      continue;
    }
    const candidates = findFiles(bundleRoot, (filePath, stat) => artifactMatches(filePath, stat, kind));
    if (candidates.length !== 1) {
      errors.push(`期望 1 个 ${kind} 制品，实际找到 ${candidates.length} 个`);
      continue;
    }
    const digest = describeDigest(candidates[0]);
    artifacts.push({
      kind,
      path: displayPath(candidates[0]),
      sizeBytes: digest.sizeBytes,
      sha256: digest.sha256,
      digestMode: digest.digestMode,
      distributionSigning: signingStatus,
    });
  }
  return artifacts;
}

function validateSupportingEvidence(paths, type, acceptedStatus, errors) {
  return paths
    .map((filePath) => ({ filePath, value: loadEvidenceFile(filePath, type, errors) }))
    .filter((entry) => entry.value)
    .map((entry) => {
      if (entry.value.status !== acceptedStatus) {
        errors.push(`${type} 未通过: ${displayPath(entry.filePath)} (status=${entry.value.status})`);
      }
      return {
        path: displayPath(entry.filePath),
        ...entry.value,
      };
    });
}

function validateSmokeKinds(smokeEvidence, requiredSmokeKinds, errors) {
  const observedKinds = new Set(smokeEvidence
    .filter((entry) => entry.status === 'passed')
    .map((entry) => entry.bundleKind));
  for (const kind of requiredSmokeKinds) {
    if (!observedKinds.has(kind)) {
      errors.push(`缺少通过的 ${kind} packaged smoke`);
    }
  }
}

function buildProvenance() {
  return {
    repository: process.env.GITHUB_REPOSITORY || null,
    workflow: process.env.GITHUB_WORKFLOW || null,
    runId: process.env.GITHUB_RUN_ID || null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT || null,
    ref: process.env.GITHUB_REF || null,
    commit: process.env.GITHUB_SHA || null,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2), {
    booleans: ['allow-incomplete'],
    repeatable: ['install', 'required-kind', 'required-smoke-kind', 'smoke', 'timing'],
  });
  const bundleRoot = requireString(args, 'bundle-root');
  const outputPath = requireString(args, 'output');
  const platform = requireString(args, 'platform');
  const signingStatus = requireString(args, 'signing-status');
  const signingReason = requireString(args, 'signing-reason');
  if (!['signed', 'unsigned'].includes(signingStatus)) {
    throw new Error('--signing-status 只能是 signed 或 unsigned');
  }

  const requiredKinds = optionalList(args, 'required-kind').map((kind) => kind.toLowerCase());
  const requiredSmokeKinds = optionalList(args, 'required-smoke-kind').map((kind) => kind.toLowerCase());
  if (requiredKinds.length === 0 || requiredSmokeKinds.length === 0) {
    throw new Error('必须至少提供一个 --required-kind 和 --required-smoke-kind');
  }

  const errors = [];
  const artifacts = collectArtifacts(bundleRoot, requiredKinds, signingStatus, errors);
  const timings = validateSupportingEvidence(optionalList(args, 'timing'), 'timing', 'passed', errors);
  const installs = validateSupportingEvidence(optionalList(args, 'install'), 'install', 'installed', errors);
  const smokes = validateSupportingEvidence(optionalList(args, 'smoke'), 'smoke', 'passed', errors);
  validateSmokeKinds(smokes, requiredSmokeKinds, errors);

  const totalMeasuredDurationMs = timings.reduce((total, timing) => (
    total + (Number.isFinite(timing.durationMs) ? timing.durationMs : 0)
  ), 0);
  const evidence = {
    schemaVersion: 1,
    status: 'pending',
    generatedAt: new Date().toISOString(),
    platform,
    runtimePlatform: process.platform,
    architecture: os.arch(),
    provenance: buildProvenance(),
    distributionSigning: {
      status: signingStatus,
      reason: signingReason,
    },
    requiredArtifacts: requiredKinds,
    requiredPackagedSmokes: requiredSmokeKinds,
    artifacts,
    timings,
    totalMeasuredDurationMs,
    installs,
    smokes,
    secretLeakScan: {
      status: 'pending',
      rule: 'no authorization secrets or Management Key value fields in evidence JSON',
    },
    errors,
  };

  evidence.secretLeakScan.status = containsSensitiveMaterial(evidence) ? 'failed' : 'passed';
  if (evidence.secretLeakScan.status === 'failed') {
    evidence.errors.push('证据 JSON 含疑似凭证字段，发布证据被拒绝');
  }
  evidence.status = evidence.errors.length === 0 ? 'passed' : 'incomplete';
  writeJson(outputPath, evidence);

  process.stdout.write(`桌面发布证据已生成: ${displayPath(outputPath)} (status=${evidence.status})\n`);
  if (evidence.status !== 'passed' && !args['allow-incomplete']) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`收集桌面发布证据失败: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  artifactMatches,
  containsSensitiveMaterial,
};
