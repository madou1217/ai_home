'use strict';

// ZCode 出口的启动前连通性探测。
//
// 这里只通过 curl 对中性 204 地址发起一次无凭据 GET，验证配置的代理确实具备
// 数据面出口；不调用、不模拟 ZCode 的任何接口。当前 ZCode 出口能力仅支持 macOS，
// 因此使用系统自带的 /usr/bin/curl，并通过 execFile 保持无 shell 边界。

const { execFile: nodeExecFile } = require('node:child_process');

const { toZcodeProxyUrl } = require('./zcode-native-proxy-values');

const DEFAULT_PROXY_PROBE_URL = 'https://www.gstatic.com/generate_204';
const DEFAULT_PROXY_PROBE_TIMEOUT_MS = 5000;
const DEFAULT_CURL_PATH = '/usr/bin/curl';

function normalizeProbeFailure(error) {
  if (!error) return 'proxy_probe_failed';
  if (error.code === 'ENOENT') return 'curl_unavailable';
  if (error.killed || error.signal || error.code === 'ETIMEDOUT') return 'proxy_probe_timeout';
  const exitCode = Number(error.code);
  return Number.isInteger(exitCode) ? `curl_exit_${exitCode}` : 'proxy_probe_failed';
}

function probeZcodeProxy(proxyServer, options = {}) {
  const proxyUrl = toZcodeProxyUrl(proxyServer);
  if (!proxyUrl) {
    return Promise.resolve({ ok: false, error: 'proxy_probe_failed', reason: 'missing_proxy_url' });
  }
  const execFile = typeof options.execFile === 'function' ? options.execFile : nodeExecFile;
  const curlPath = String(options.curlPath || DEFAULT_CURL_PATH).trim() || DEFAULT_CURL_PATH;
  const targetUrl = String(options.targetUrl || DEFAULT_PROXY_PROBE_URL).trim()
    || DEFAULT_PROXY_PROBE_URL;
  const timeoutMs = Math.max(
    250,
    Math.min(Number(options.timeoutMs) || DEFAULT_PROXY_PROBE_TIMEOUT_MS, 15000)
  );
  const timeoutSeconds = String(Math.max(1, Math.ceil(timeoutMs / 1000)));
  const args = [
    '--disable',
    '--silent',
    '--show-error',
    '--fail',
    '--output', '/dev/null',
    '--connect-timeout', timeoutSeconds,
    '--max-time', timeoutSeconds,
    '--noproxy', '',
    '--proxy', proxyUrl,
    targetUrl
  ];

  return new Promise((resolve) => {
    try {
      execFile(curlPath, args, {
        encoding: 'utf8',
        killSignal: 'SIGKILL',
        maxBuffer: 8 * 1024,
        timeout: timeoutMs + 1000,
        windowsHide: true
      }, (error) => {
        if (error) {
          resolve({
            ok: false,
            error: 'proxy_probe_failed',
            reason: normalizeProbeFailure(error)
          });
          return;
        }
        resolve({ ok: true });
      });
    } catch (error) {
      resolve({
        ok: false,
        error: 'proxy_probe_failed',
        reason: normalizeProbeFailure(error)
      });
    }
  });
}

module.exports = {
  DEFAULT_CURL_PATH,
  DEFAULT_PROXY_PROBE_TIMEOUT_MS,
  DEFAULT_PROXY_PROBE_URL,
  probeZcodeProxy
};
