'use strict';

/**
 * 构件库（Go `aih-go __artifacts-ensure`）的进程内客户端。
 *
 * 只有"把请求交给执行点、把 JSON 拿回来"这一件事：路径发现、保留策略、adopt 钩子等
 * provider 逻辑都留在调用方。二进制缺失或能力探测失败时由调用方回退本地实现，
 * 这里只如实报告不可用。
 */

const nodePath = require('node:path');

let capabilityState = null;

function resolveArtifactServiceBinary() {
  const override = String(process.env.AIH_ARTIFACT_GO_BINARY || '').trim();
  if (override) return override;
  const platform = process.platform;
  const arch = process.arch;
  const binary = platform === 'win32' ? 'aih-go.exe' : 'aih-go';
  return nodePath.join(nodePath.resolve(__dirname, '..', '..'), 'bin', 'native', platform + '-' + arch, binary);
}

function artifactServiceAvailable(binary) {
  if (capabilityState !== null) return capabilityState;
  try {
    const output = require('node:child_process').execFileSync(binary, ['__artifacts-ensure', '--capabilities'], {
      encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore']
    });
    capabilityState = String(output).trim() === 'aih-artifactstore-v1';
  } catch (_error) {
    capabilityState = false;
  }
  return capabilityState;
}

function runArtifactService(binary, payload) {
  const output = require('node:child_process').execFileSync(binary, ['__artifacts-ensure'], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const text = String(output).trim();
  if (!text) throw new Error('artifact_service_empty_output');
  return JSON.parse(text);
}

// 后端选择：auto（默认，能用 Go 就用）/ node（强制本地回退）/ go（优先 Go，失败仍回退）。
function artifactBackendMode() {
  return String(process.env.AIH_ARTIFACT_BACKEND || 'auto').toLowerCase();
}

function artifactServiceReady() {
  if (artifactBackendMode() === 'node') return false;
  return artifactServiceAvailable(resolveArtifactServiceBinary());
}

function resetArtifactServiceProbe() {
  capabilityState = null;
}

module.exports = {
  artifactBackendMode,
  artifactServiceAvailable,
  artifactServiceReady,
  resetArtifactServiceProbe,
  resolveArtifactServiceBinary,
  runArtifactService
};
