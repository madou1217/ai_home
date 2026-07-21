#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseArgs, requireString } = require('./lib/cli');
const { describeDigest, displayPath, readJson } = require('./lib/fs-utils');

function validateEvidence(evidence, workspaceRoot) {
  const errors = [];
  if (evidence.schemaVersion !== 1) {
    errors.push(`不支持的 schemaVersion: ${evidence.schemaVersion}`);
  }
  if (evidence.status !== 'passed') {
    errors.push(`release evidence 状态不是 passed: ${evidence.status}`);
  }
  if (!['signed', 'unsigned'].includes(evidence.distributionSigning?.status)) {
    errors.push('distributionSigning.status 必须明确为 signed 或 unsigned');
  }
  if (!evidence.distributionSigning?.reason) {
    errors.push('distributionSigning.reason 不能为空');
  }
  if (evidence.secretLeakScan?.status !== 'passed') {
    errors.push('secretLeakScan 未通过');
  }

  const artifactsByKind = new Map((evidence.artifacts || []).map((artifact) => [artifact.kind, artifact]));
  for (const kind of evidence.requiredArtifacts || []) {
    const artifact = artifactsByKind.get(kind);
    if (!artifact) {
      errors.push(`缺少 ${kind} 制品证据`);
      continue;
    }
    const artifactPath = path.isAbsolute(artifact.path)
      ? artifact.path
      : path.resolve(workspaceRoot, artifact.path);
    if (!fs.existsSync(artifactPath)) {
      errors.push(`${kind} 制品不存在: ${artifact.path}`);
      continue;
    }
    const digest = describeDigest(artifactPath);
    if (digest.sha256 !== artifact.sha256 || digest.sizeBytes !== artifact.sizeBytes) {
      errors.push(`${kind} 制品 SHA256 或大小与证据不一致`);
    }
    if (digest.digestMode !== artifact.digestMode) {
      errors.push(`${kind} 制品摘要模式不一致`);
    }
  }

  const passedSmokeKinds = new Set((evidence.smokes || [])
    .filter((smoke) => smoke.status === 'passed' && smoke.secretLeakScan?.status === 'passed')
    .map((smoke) => smoke.bundleKind));
  for (const kind of evidence.requiredPackagedSmokes || []) {
    if (!passedSmokeKinds.has(kind)) {
      errors.push(`${kind} packaged smoke 证据缺失或未通过`);
    }
  }
  if ((evidence.timings || []).some((timing) => timing.status !== 'passed')) {
    errors.push('至少一个计时步骤未通过');
  }
  if ((evidence.installs || []).some((install) => install.status !== 'installed')) {
    errors.push('至少一个安装步骤未通过');
  }
  return errors;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const evidencePath = requireString(args, 'evidence');
  const workspaceRoot = args['workspace-root'] || process.cwd();
  const evidence = readJson(evidencePath);
  const errors = validateEvidence(evidence, workspaceRoot);
  if (errors.length > 0) {
    process.stderr.write(`桌面发布证据校验失败 (${errors.length}):\n- ${errors.join('\n- ')}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`桌面发布证据校验通过: ${displayPath(evidencePath)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`校验桌面发布证据失败: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  validateEvidence,
};
