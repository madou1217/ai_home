'use strict';

const { authorizeManagementKey } = require('./management-key-auth');

const FABRIC_TRANSPORT_ECHO_PATH = '/v0/fabric/transport/echo';

let echoServer = null;

function writeUpgradeError(socket, statusCode, reason) {
  const code = Number(statusCode) || 500;
  const text = reason || 'Error';
  try {
    socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`);
  } catch (_error) {}
  try {
    socket.destroy();
  } catch (_error) {}
}

function createEchoServer(WebSocket) {
  const server = new WebSocket.Server({ noServer: true });
  server.on('connection', (socket) => {
    socket.on('message', (data) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(data);
    });
  });
  return server;
}

function getEchoServer(WebSocket) {
  if (!echoServer) echoServer = createEchoServer(WebSocket);
  return echoServer;
}

function handleFabricTransportEchoUpgrade({ req, socket, head, deps = {} }) {
  const WebSocket = deps.WebSocket;
  if (!WebSocket || !WebSocket.Server) {
    writeUpgradeError(socket, 500, 'Internal Server Error');
    return;
  }

  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if ((url.pathname || '/') !== FABRIC_TRANSPORT_ECHO_PATH) {
    writeUpgradeError(socket, 404, 'Not Found');
    return;
  }

  const authorization = authorizeManagementKey({
    req,
    requiredManagementKey: deps.requiredManagementKey,
    deps
  });
  if (!authorization.ok) {
    const statusCode = authorization.statusCode || 401;
    writeUpgradeError(socket, statusCode, statusCode === 503 ? 'Service Unavailable' : 'Unauthorized');
    return;
  }

  const server = getEchoServer(WebSocket);
  server.handleUpgrade(req, socket, head, (webSocket) => {
    server.emit('connection', webSocket, req);
  });
}

module.exports = {
  FABRIC_TRANSPORT_ECHO_PATH,
  handleFabricTransportEchoUpgrade
};
