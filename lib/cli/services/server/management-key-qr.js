'use strict';

const os = require('node:os');
const { QrCode, Ecc } = require('./qrcodegen');

const { buildManagementKeyQrPayload, normalizeEndpoint } = require('../../../protocol/server-credentials-qr');
const { listLanIPv4Candidates } = require('../../../server/control-plane-endpoint-hints');
const { isLoopbackHost } = require('../../../control-endpoint');

function resolveAdvertisedHost(config = {}, networkInterfaces = os.networkInterfaces) {
  const configured = String(config.host || '').trim();
  const candidates = listLanIPv4Candidates(networkInterfaces);
  if ((!configured || isLoopbackHost(configured)) && candidates.length) return candidates[0].address;
  if (configured && !['0.0.0.0', '::', '[::]'].includes(configured)) return configured;
  if (candidates.length) return candidates[0].address;
  return '127.0.0.1';
}

function resolveManagementKeyQrEndpoint(config = {}, options = {}) {
  const host = resolveAdvertisedHost(config, options.networkInterfaces);
  const port = Number(config.port);
  const normalizedPort = Number.isInteger(port) && port > 0 && port <= 65535 ? port : 9527;
  const formattedHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${formattedHost}:${normalizedPort}`;
}

function buildQrMatrix(value) {
  let qr;
  try { qr = QrCode.encodeText(String(value), Ecc.MEDIUM); } catch (_error) {
    throw new Error('Server URL 或 Management Key 太长，超过单个二维码容量，请使用手动输入。');
  }
  const quietZone = 4;
  const size = qr.size + quietZone * 2;
  const matrix = [];
  for (let y = 0; y < size; y += 1) {
    const row = [];
    for (let x = 0; x < size; x += 1) {
      row.push(
        x >= quietZone
        && x < quietZone + qr.size
        && y >= quietZone
        && y < quietZone + qr.size
        && qr.getModule(x - quietZone, y - quietZone)
      );
    }
    matrix.push(row);
  }
  return matrix;
}

function renderQrTerminal(value, options = {}) {
  const matrix = buildQrMatrix(value);
  const columns = Number(options.columns) || 0;
  if (columns && matrix.length > columns) throw new Error(`二维码需要至少 ${matrix.length} 列，请放宽终端窗口后重试。`);
  const lines = [];
  for (let y = 0; y < matrix.length; y += 2) {
    const line = matrix[y].map((cell, x) => ' ▄▀█'[(cell ? 2 : 0) + (matrix[y + 1]?.[x] ? 1 : 0)]).join('');
    // Explicit white background is essential on dark terminal themes.
    lines.push(`\x1b[30;47m${line}\x1b[0m`);
  }
  return lines.join('\n');
}

function printManagementKeyQr(config = {}, io = {}) {
  const log = typeof io.log === 'function' ? io.log : console.log;
  const endpoint = normalizeEndpoint(io.endpoint || resolveManagementKeyQrEndpoint(config, io));
  const payload = buildManagementKeyQrPayload({
    endpoint,
    managementKey: config.managementKey
  });
  log(renderQrTerminal(payload, io));
  log(`\n扫码后在手机 Server Setup 中确认并提交。Server URL：${endpoint}`);
  return { endpoint, payload };
}

module.exports = { resolveAdvertisedHost, resolveManagementKeyQrEndpoint, buildQrMatrix, renderQrTerminal, printManagementKeyQr };
