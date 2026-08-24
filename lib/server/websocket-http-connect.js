'use strict';

const net = require('node:net');
const tls = require('node:tls');
const http = require('node:http');
const https = require('node:https');

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const MAX_CONNECT_RESPONSE_BYTES = 64 * 1024;

function connectError(code, detail, cause) {
  const message = detail ? `${code}:${detail}` : code;
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function decodeUrlCredential(value) {
  try {
    return decodeURIComponent(String(value || ''));
  } catch {
    throw connectError('invalid_proxy_url');
  }
}

function stripIpv6Brackets(value) {
  const host = String(value || '').trim();
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

function formatAuthority(host, port) {
  const normalizedHost = stripIpv6Brackets(host);
  const hostPart = normalizedHost.includes(':') ? `[${normalizedHost}]` : normalizedHost;
  return `${hostPart}:${port}`;
}

function parseHttpProxyUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || '').trim());
  } catch (error) {
    throw connectError('invalid_proxy_url', '', error);
  }
  if (parsed.protocol !== 'http:') {
    throw connectError('unsupported_websocket_proxy_protocol', parsed.protocol || 'unknown');
  }
  const host = stripIpv6Brackets(parsed.hostname);
  const port = Number(parsed.port || 80);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw connectError('invalid_proxy_url');
  }
  const username = decodeUrlCredential(parsed.username);
  const password = decodeUrlCredential(parsed.password);
  const authorization = username || password
    ? `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
    : '';
  return { host, port, authorization };
}

function normalizeTimeoutMs(value) {
  const timeoutMs = Number(value);
  return Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.max(10, Math.min(timeoutMs, 60_000))
    : DEFAULT_CONNECT_TIMEOUT_MS;
}

function buildConnectRequest(targetAuthority, authorization) {
  return [
    `CONNECT ${targetAuthority} HTTP/1.1`,
    `Host: ${targetAuthority}`,
    'Proxy-Connection: Keep-Alive',
    ...(authorization ? [`Proxy-Authorization: ${authorization}`] : []),
    '',
    ''
  ].join('\r\n');
}

function buildTlsOptions(targetOptions, proxySocket, targetHost) {
  const tlsOptions = {
    ...(targetOptions || {}),
    socket: proxySocket
  };
  delete tlsOptions.agent;
  delete tlsOptions.createConnection;
  delete tlsOptions.host;
  delete tlsOptions.hostname;
  delete tlsOptions.path;
  delete tlsOptions.port;
  if (tlsOptions.servername === undefined) {
    tlsOptions.servername = net.isIP(targetHost) ? '' : targetHost;
  }
  return tlsOptions;
}

function createHttpConnectConnection(proxyUrl, options = {}) {
  const proxy = parseHttpProxyUrl(proxyUrl);
  const timeoutMs = normalizeTimeoutMs(options.timeoutMs);
  const secureTarget = options.secureTarget === true;
  const netConnect = typeof options.netConnect === 'function' ? options.netConnect : net.connect;
  const tlsConnect = typeof options.tlsConnect === 'function' ? options.tlsConnect : tls.connect;

  return function createConnection(targetOptions = {}, callback = () => {}) {
    const targetHost = stripIpv6Brackets(targetOptions.hostname || targetOptions.host);
    const targetPort = Number(targetOptions.port || (secureTarget ? 443 : 80));
    if (!targetHost || !Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
      callback(connectError('invalid_websocket_target'));
      return undefined;
    }

    const targetAuthority = formatAuthority(targetHost, targetPort);
    let proxySocket;
    let response = Buffer.alloc(0);
    let settled = false;

    const finish = (error, socket) => {
      if (settled) return;
      settled = true;
      callback(error || null, socket);
    };
    const fail = (error) => {
      try { proxySocket?.destroy(); } catch {}
      finish(error);
    };
    const onError = (error) => fail(connectError(
      'proxy_connect_failed',
      String(error?.code || error?.message || 'unknown'),
      error
    ));
    const onTimeout = () => fail(connectError('proxy_connect_timeout'));
    const onEnd = () => fail(connectError('proxy_connect_closed'));
    const onClose = () => fail(connectError('proxy_connect_closed'));
    const removeTunnelListeners = () => {
      proxySocket.removeListener('data', onData);
      proxySocket.removeListener('error', onError);
      proxySocket.removeListener('timeout', onTimeout);
      proxySocket.removeListener('end', onEnd);
      proxySocket.removeListener('close', onClose);
      proxySocket.setTimeout?.(0);
    };
    const onData = (chunk) => {
      response = Buffer.concat([response, chunk]);
      if (response.length > MAX_CONNECT_RESPONSE_BYTES) {
        fail(connectError('proxy_connect_response_too_large'));
        return;
      }
      const headerEnd = response.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const header = response.subarray(0, headerEnd).toString('latin1');
      const statusMatch = /^HTTP\/1\.[01]\s+(\d{3})(?:\s|$)/i.exec(header);
      const statusCode = statusMatch ? Number(statusMatch[1]) : 0;
      if (statusCode !== 200) {
        fail(connectError('proxy_connect_rejected', statusCode || 'invalid_response'));
        return;
      }

      removeTunnelListeners();
      const remainder = response.subarray(headerEnd + 4);
      if (remainder.length > 0) proxySocket.unshift(remainder);
      if (!secureTarget) {
        finish(null, proxySocket);
        return;
      }

      let secureSocket;
      try {
        secureSocket = tlsConnect(buildTlsOptions(targetOptions, proxySocket, targetHost));
      } catch (error) {
        fail(connectError('proxy_tls_failed', String(error?.message || 'unknown'), error));
        return;
      }
      const onTlsError = (error) => {
        try { secureSocket.destroy(); } catch {}
        finish(connectError('proxy_tls_failed', String(error?.code || error?.message || 'unknown'), error));
      };
      const onTlsTimeout = () => {
        try { secureSocket.destroy(); } catch {}
        finish(connectError('proxy_connect_timeout'));
      };
      const onTlsClose = () => finish(connectError('proxy_tls_closed'));
      secureSocket.setTimeout?.(timeoutMs);
      secureSocket.once('error', onTlsError);
      secureSocket.once('timeout', onTlsTimeout);
      secureSocket.once('close', onTlsClose);
      secureSocket.once('secureConnect', () => {
        secureSocket.removeListener('error', onTlsError);
        secureSocket.removeListener('timeout', onTlsTimeout);
        secureSocket.removeListener('close', onTlsClose);
        secureSocket.setTimeout?.(0);
        finish(null, secureSocket);
      });
    };

    try {
      proxySocket = netConnect({ host: proxy.host, port: proxy.port });
      proxySocket.setNoDelay?.(true);
      proxySocket.setTimeout?.(timeoutMs);
      proxySocket.on('data', onData);
      proxySocket.once('error', onError);
      proxySocket.once('timeout', onTimeout);
      proxySocket.once('end', onEnd);
      proxySocket.once('close', onClose);
      proxySocket.once('connect', () => {
        proxySocket.write(buildConnectRequest(targetAuthority, proxy.authorization));
      });
    } catch (error) {
      fail(connectError('proxy_connect_failed', String(error?.message || 'unknown'), error));
    }
    return undefined;
  };
}

function createHttpConnectAgent(proxyUrl, options = {}) {
  const agent = options.secureTarget === true
    ? new https.Agent({ keepAlive: false })
    : new http.Agent({ keepAlive: false });
  agent.createConnection = createHttpConnectConnection(proxyUrl, options);
  return agent;
}

module.exports = {
  createHttpConnectAgent,
  createHttpConnectConnection
};
