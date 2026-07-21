'use strict';

function parseFrame(data) {
  try {
    return JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data || ''));
  } catch (_error) {
    return null;
  }
}

function sendFrame(socket, frame) {
  if (!socket || socket.readyState !== 1) return false;
  try {
    socket.send(JSON.stringify(frame));
    return true;
  } catch (_error) {
    return false;
  }
}

function brokerStreamError(code, responseStarted = false) {
  const error = new Error(code);
  error.code = code;
  error.responseStarted = responseStarted;
  return error;
}

function applyResponseStart(res, frame, serverId) {
  const status = Number(frame.status);
  res.statusCode = status >= 100 && status <= 599 ? status : 502;
  Object.entries(frame.headers || {}).forEach(([name, value]) => {
    if (value === undefined || typeof res.setHeader !== 'function') return;
    res.setHeader(name, Array.isArray(value) ? value.join(', ') : String(value));
  });
  if (typeof res.setHeader === 'function') {
    res.setHeader('x-aih-fabric-broker-server-id', serverId);
    if (!Object.hasOwn(frame.headers || {}, 'cache-control')) res.setHeader('cache-control', 'no-store');
  }
}

function streamBrokerResponse(input = {}) {
  const {
    socket,
    requestId,
    serverId,
    res,
    requestFrame
  } = input;
  const timeoutMs = Math.max(1000, Number(input.timeoutMs) || 30_000);
  const scheduleTimeout = input.setTimeout || setTimeout;
  const cancelTimeout = input.clearTimeout || clearTimeout;

  return new Promise((resolve, reject) => {
    let responseStarted = false;
    let settled = false;
    let expectedSequence = 0;
    let timer = scheduleTimeout(() => {
      if (settled) return;
      sendFrame(socket, { type: 'broker.request.cancel', requestId, reason: 'timeout' });
      finish(reject, brokerStreamError('broker_request_timeout', responseStarted));
    }, timeoutMs);
    if (timer && typeof timer.unref === 'function') timer.unref();

    function clearResponseTimeout() {
      if (!timer) return;
      cancelTimeout(timer);
      timer = null;
    }

    function cleanup() {
      clearResponseTimeout();
      socket.off('message', onMessage);
      socket.off('close', onSocketClose);
      socket.off('error', onSocketError);
      if (res && typeof res.off === 'function') res.off('close', onClientClose);
    }

    function finish(callback, value) {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    }

    function onClientClose() {
      if (settled) return;
      sendFrame(socket, { type: 'broker.request.cancel', requestId, reason: 'client_disconnected' });
      finish(resolve, { ok: false, cancelled: true, responseStarted });
    }

    function onSocketClose() {
      finish(reject, brokerStreamError('broker_server_link_closed', responseStarted));
    }

    function onSocketError() {
      finish(reject, brokerStreamError('broker_server_link_error', responseStarted));
    }

    function onMessage(data) {
      const frame = parseFrame(data);
      if (!frame || frame.requestId !== requestId) return;

      if (frame.type === 'broker.response') {
        applyResponseStart(res, frame, serverId);
        responseStarted = true;
        const body = frame.bodyBase64 ? Buffer.from(String(frame.bodyBase64), 'base64') : Buffer.alloc(0);
        finish(resolve, { ok: true, responseStarted: true, legacy: true });
        res.end(body);
        return;
      }

      if (frame.type === 'broker.response.start') {
        if (responseStarted) {
          finish(reject, brokerStreamError('broker_duplicate_response_start', true));
          return;
        }
        applyResponseStart(res, frame, serverId);
        responseStarted = true;
        clearResponseTimeout();
        return;
      }

      if (frame.type === 'broker.response.chunk') {
        if (!responseStarted || Number(frame.sequence) !== expectedSequence) {
          finish(reject, brokerStreamError('broker_invalid_response_sequence', responseStarted));
          return;
        }
        expectedSequence += 1;
        if (frame.bodyBase64) res.write(Buffer.from(String(frame.bodyBase64), 'base64'));
        return;
      }

      if (frame.type === 'broker.response.error') {
        finish(reject, brokerStreamError(String(frame.error || 'broker_response_error'), responseStarted));
        return;
      }

      if (frame.type === 'broker.response.end') {
        if (!responseStarted) {
          finish(reject, brokerStreamError('broker_response_start_missing', false));
          return;
        }
        finish(resolve, { ok: true, responseStarted: true });
        res.end();
      }
    }

    socket.on('message', onMessage);
    socket.once('close', onSocketClose);
    socket.once('error', onSocketError);
    if (res && typeof res.once === 'function') res.once('close', onClientClose);

    if (requestFrame && !sendFrame(socket, requestFrame)) {
      finish(reject, brokerStreamError('fabric_broker_send_failed', false));
    }
  });
}

module.exports = {
  streamBrokerResponse
};
