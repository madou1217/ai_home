'use strict';

const { joinRemoteNodeWithInvite } = require('./remote/node-join');
const { buildControlPlaneDescriptor } = require('./control-plane-descriptor');
const { buildNodeDoctorReport } = require('../cli/services/node/doctor');
const {
  authorizeManagementKey,
  authorizeManagementKeyOrLoopback
} = require('./management-key-auth');
const { buildControlPlaneDeviceAccounts } = require('./control-plane-device-accounts');
const {
  buildControlPlaneDeviceSessionEvents,
  buildControlPlaneDeviceSessionMessages,
  buildControlPlaneDeviceSessions
} = require('./control-plane-device-sessions');
const {
  attachRemoteDevelopmentSession,
  buildRemoteDevelopmentSessionCatalog
} = require('./control-plane-device-session-catalog');
const {
  buildForwardedSessionCommandPayload,
  executeRemoteDevelopmentSessionCommand
} = require('./control-plane-device-session-command');
const { readSessionArtifact } = require('./control-plane-device-session-artifact-store');
const { ackSessionEvents } = require('./control-plane-device-session-event-store');
const { writeDeviceSessionInput } = require('./control-plane-device-session-input');
const {
  abortNativeSessionRun,
  readNativeSessionRunEvents,
  startNativeDeviceSession,
  writeNativeSessionRunInput
} = require('./control-plane-device-session-start');
const { buildControlPlaneDeviceStatus } = require('./control-plane-device-status');
const { getRemoteNode, normalizeId } = require('./remote/node-registry');
const { listNodeTransports } = require('./remote/transport-registry');
const { listRemoteNodeViews } = require('./remote/remote-node-view');
const {
  requestRemoteManagement,
  streamRemoteManagement
} = require('./remote/remote-gateway');
const { nodeSupportsCapability } = require('./remote/remote-management-routes');
const {
  attachSseWatcher,
  openSseStream,
  removeSseWatcher,
  writeSseJson
} = require('./webui-sse-broadcaster');
const {
  handleReauthAccountRequest
} = require('./webui-account-routes');
const {
  serializeAuthJob
} = require('./web-account-auth');
const { isAccountRef } = require('./account-ref-store');

const { DEVICE_SESSION_REF_PATTERN, DEFAULT_PROVIDER_AUTH_JOB_READY_TIMEOUT_MS, DEFAULT_DEVICE_SESSION_STREAM_INTERVAL_MS, MIN_DEVICE_SESSION_STREAM_INTERVAL_MS, MAX_DEVICE_SESSION_STREAM_INTERVAL_MS, DEFAULT_DEVICE_NODE_STREAM_RECONNECTS, DEFAULT_DEVICE_NODE_STREAM_RECONNECT_DELAY_MS, MAX_DEVICE_NODE_STREAM_RECONNECTS, authorizeNodeRpc, writeNodeRpcNotFound, writeNodeRpcForbidden, writePublicNodeRpcHeaders, readJsonPayload, sessionRefFromUrl, isValidSessionRef, authorizeRemoteClientRequest, artifactIdFromUrl, writeInvalidSessionRef } = require('./node-rpc-router-utils');
const { handleDeviceNodesRequest, nodeIdFromUrl, nodeIdFromPayload, buildDeviceNodeSessionMessagesPath, buildDeviceNodeSessionsPath, buildDeviceNodeSessionCatalogPath, buildDeviceNodeSessionStreamPath, buildDeviceNodeSessionInputPayload, buildDeviceNodeSessionResumePath, cursorFromRemoteSessionFrame, deviceNodeStreamReconnects, deviceNodeStreamReconnectDelayMs, isRetryableRemoteStreamError, waitForDeviceNodeStreamReconnect, isWritableResponse, normalizeRemoteSessionStreamChunk, normalizeRemoteTransportEvidence, normalizeRemoteSessionEnvelope, normalizeRemoteSessionMessagesResult, normalizeRemoteSessionsResult, normalizeRemoteSessionCatalogResult, normalizeRemoteSessionAttachResult, normalizeRemoteSessionCommandResult, normalizeRemoteSessionAckResult, normalizeRemoteSessionArtifactResult, normalizeRemoteSessionInputResult, normalizeRemoteSessionStartResult, normalizeRemoteSessionRunEventsResult, normalizeRemoteSessionRunInputResult, normalizeRemoteSessionRunAbortResult, handleDeviceNodeSessionsRequest, handleDeviceNodeSessionCatalogRequest, handleDeviceNodeSessionMessagesRequest, handleDeviceNodeSessionInputRequest, buildDeviceNodeSessionStartPayload, buildDeviceNodeSessionRunEventsPath, buildDeviceNodeSessionArtifactPath, buildDeviceNodeSessionRunInputPayload, buildDeviceNodeSessionRunAbortPayload, buildDeviceNodeSessionAttachPayload, buildDeviceNodeSessionAckPayload, runIdFromUrl, runIdFromPayload, handleDeviceNodeSessionStartRequest, handleDeviceNodeSessionAttachRequest, handleDeviceNodeSessionCommandRequest, handleDeviceNodeSessionAckRequest, handleDeviceNodeSessionRunEventsRequest, handleDeviceNodeSessionArtifactRequest, handleDeviceNodeSessionRunInputRequest, handleDeviceNodeSessionRunAbortRequest, streamDeviceNodeSessionWithResume, handleDeviceNodeSessionStreamRequest } = require('./node-rpc-router-device-node');
const { streamIntervalFromUrl, buildDeviceSessionsOptions, loadDeviceProjectsSnapshot, handleDeviceSessionsRequest, handleNodeSessionsRequest, handleNodeSessionCatalogRequest, getSessionReaderDeps, handleAuthorizedSessionMessagesRequest, getSessionCatalogDeps, handleDeviceSessionMessagesRequest, handleNodeSessionMessagesRequest, handleDeviceSessionEventsRequest, buildSessionStreamPayload, writeSessionStreamFrame, handleAuthorizedSessionStreamRequest, handleDeviceSessionStreamRequest, handleNodeSessionStreamRequest, handleNodeSessionInputRequest, handleNodeSessionStartRequest, handleNodeSessionAttachRequest, handleNodeSessionCommandRequest, handleNodeSessionAckRequest, handleNodeSessionRunEventsRequest, handleNodeSessionArtifactRequest, handleNodeSessionRunInputRequest, handleNodeSessionRunAbortRequest } = require('./node-rpc-router-session');
const { codeFromUrl, joinErrorStatus, handleNodeJoinRequest } = require('./node-rpc-router-join');
const { normalizeProviderSegment, normalizeAccountRefSegment, normalizeAuthJobId, createJsonRelayResponse, parseJsonRelayBody, normalizeProviderAuthJobWaitMs, delay, hasActionableAuthJobState, waitForProviderAuthJob, enrichProviderAccountReauthResult, handleDeviceAccountsRequest, handleDeviceProviderAccountReauthRequest, getProviderAuthJobManager, writeProviderAuthJobUnavailable, writeSerializedProviderAuthJob, handleDeviceProviderAccountAuthJobGetRequest, handleDeviceProviderAccountAuthJobCancelRequest, handleDeviceProviderAccountAuthJobCallbackRequest } = require('./node-rpc-router-provider-account');
const { firstHeaderValue, inferRequestEndpoint, buildDescriptorForRequest, handleDeviceProfileRequest, handleDeviceStatusRequest, shouldIncludeNodeDiagnostics, buildNodeDiagnosticsForRequest, attachNodeDiagnostics } = require('./node-rpc-router-profile-status');
async function handleNodeRpcRequest(ctx) {
  const { method, pathname, res, options, state, deps } = ctx;
  if (!String(pathname || '').startsWith('/v0/node-rpc')) return false;

  if (method === 'OPTIONS' && (
    pathname === '/v0/node-rpc/descriptor'
    || pathname === '/v0/node-rpc/device-profile'
    || pathname === '/v0/node-rpc/device-status'
    || pathname === '/v0/node-rpc/device-accounts'
    || pathname === '/v0/node-rpc/device-sessions'
    || pathname === '/v0/node-rpc/device-session-messages'
    || pathname === '/v0/node-rpc/device-session-events'
    || pathname === '/v0/node-rpc/device-session-stream'
    || pathname === '/v0/node-rpc/device-node-sessions'
    || pathname === '/v0/node-rpc/device-node-session-catalog'
    || pathname === '/v0/node-rpc/device-node-session-messages'
    || pathname === '/v0/node-rpc/device-node-session-stream'
    || pathname === '/v0/node-rpc/device-node-session-input'
    || pathname === '/v0/node-rpc/device-node-session-start'
    || pathname === '/v0/node-rpc/device-node-session-attach'
    || pathname === '/v0/node-rpc/device-node-session-command'
    || pathname === '/v0/node-rpc/device-node-session-ack'
    || pathname === '/v0/node-rpc/device-node-session-run-events'
    || pathname === '/v0/node-rpc/device-node-session-artifact'
    || pathname === '/v0/node-rpc/device-node-session-run-input'
    || pathname === '/v0/node-rpc/device-node-session-run-abort'
    || pathname === '/v0/node-rpc/device-nodes'
  )) {
    writePublicNodeRpcHeaders(res);
    res.statusCode = 204;
    res.end();
    return true;
  }

  if (method === 'POST' && pathname === '/v0/node-rpc/join') {
    return handleNodeJoinRequest(ctx);
  }

  if (method === 'GET' && pathname === '/v0/node-rpc/descriptor') {
    writePublicNodeRpcHeaders(res);
    deps.writeJson(res, 200, {
      ok: true,
      rpc: 'control_plane.descriptor.read',
      result: buildDescriptorForRequest(ctx)
    });
    return true;
  }

  if (method === 'GET' && pathname === '/v0/node-rpc/device-profile') {
    return handleDeviceProfileRequest(ctx);
  }

  if (method === 'GET' && pathname === '/v0/node-rpc/device-status') {
    return handleDeviceStatusRequest(ctx);
  }

  if (method === 'GET' && pathname === '/v0/node-rpc/device-accounts') {
    return handleDeviceAccountsRequest(ctx);
  }

  if (method === 'POST' && pathname === '/v0/node-rpc/device-provider-account-reauth') {
    return handleDeviceProviderAccountReauthRequest(ctx);
  }

  if (method === 'GET' && pathname === '/v0/node-rpc/device-provider-account-auth-job') {
    return handleDeviceProviderAccountAuthJobGetRequest(ctx);
  }

  if (method === 'POST' && pathname === '/v0/node-rpc/device-provider-account-auth-job-cancel') {
    return handleDeviceProviderAccountAuthJobCancelRequest(ctx);
  }

  if (method === 'POST' && pathname === '/v0/node-rpc/device-provider-account-auth-job-callback') {
    return handleDeviceProviderAccountAuthJobCallbackRequest(ctx);
  }

  if (method === 'GET' && pathname === '/v0/node-rpc/device-sessions') {
    return handleDeviceSessionsRequest(ctx);
  }

  if (method === 'GET' && pathname === '/v0/node-rpc/device-session-messages') {
    return handleDeviceSessionMessagesRequest(ctx);
  }

  if (method === 'GET' && pathname === '/v0/node-rpc/device-session-events') {
    return handleDeviceSessionEventsRequest(ctx);
  }

  if (method === 'GET' && pathname === '/v0/node-rpc/device-session-stream') {
    return handleDeviceSessionStreamRequest(ctx);
  }

  if (method === 'GET' && pathname === '/v0/node-rpc/device-node-sessions') {
    return handleDeviceNodeSessionsRequest(ctx);
  }

  if (method === 'GET' && pathname === '/v0/node-rpc/device-node-session-catalog') {
    return handleDeviceNodeSessionCatalogRequest(ctx);
  }

  if (method === 'GET' && pathname === '/v0/node-rpc/device-node-session-messages') {
    return handleDeviceNodeSessionMessagesRequest(ctx);
  }

  if (method === 'GET' && pathname === '/v0/node-rpc/device-node-session-stream') {
    return handleDeviceNodeSessionStreamRequest(ctx);
  }

  if (method === 'POST' && pathname === '/v0/node-rpc/device-node-session-input') {
    return handleDeviceNodeSessionInputRequest(ctx);
  }

  if (method === 'POST' && pathname === '/v0/node-rpc/device-node-session-start') {
    return handleDeviceNodeSessionStartRequest(ctx);
  }

  if (method === 'POST' && pathname === '/v0/node-rpc/device-node-session-attach') {
    return handleDeviceNodeSessionAttachRequest(ctx);
  }

  if (method === 'POST' && pathname === '/v0/node-rpc/device-node-session-command') {
    return handleDeviceNodeSessionCommandRequest(ctx);
  }

  if (method === 'POST' && pathname === '/v0/node-rpc/device-node-session-ack') {
    return handleDeviceNodeSessionAckRequest(ctx);
  }

  if (method === 'GET' && pathname === '/v0/node-rpc/device-node-session-run-events') {
    return handleDeviceNodeSessionRunEventsRequest(ctx);
  }

  if (method === 'GET' && pathname === '/v0/node-rpc/device-node-session-artifact') {
    return handleDeviceNodeSessionArtifactRequest(ctx);
  }

  if (method === 'POST' && pathname === '/v0/node-rpc/device-node-session-run-input') {
    return handleDeviceNodeSessionRunInputRequest(ctx);
  }

  if (method === 'POST' && pathname === '/v0/node-rpc/device-node-session-run-abort') {
    return handleDeviceNodeSessionRunAbortRequest(ctx);
  }

  if (method === 'GET' && pathname === '/v0/node-rpc/device-nodes') {
    return handleDeviceNodesRequest(ctx);
  }

  const authorization = authorizeNodeRpc(ctx);
  if (!authorization.ok) {
    writeNodeRpcForbidden(ctx, authorization.statusCode, authorization.error);
    return true;
  }

  if (method === 'GET' && pathname === '/v0/node-rpc/status') {
    const status = deps.buildManagementStatusPayload(state, options, {
      accountStateIndex: deps.accountStateIndex
    });
    deps.writeJson(res, 200, {
      ok: true,
      rpc: 'node.status.read',
      result: attachNodeDiagnostics(status, ctx)
    });
    return true;
  }

  if (method === 'GET' && pathname === '/v0/node-rpc/sessions') {
    return handleNodeSessionsRequest(ctx);
  }

  if (method === 'GET' && pathname === '/v0/node-rpc/session-catalog') {
    return handleNodeSessionCatalogRequest(ctx);
  }

  if (method === 'GET' && pathname === '/v0/node-rpc/session-messages') {
    return handleNodeSessionMessagesRequest(ctx);
  }

  if (method === 'GET' && pathname === '/v0/node-rpc/session-stream') {
    return handleNodeSessionStreamRequest(ctx);
  }

  if (method === 'POST' && pathname === '/v0/node-rpc/session-input') {
    return handleNodeSessionInputRequest(ctx);
  }

  if (method === 'POST' && pathname === '/v0/node-rpc/session-start') {
    return handleNodeSessionStartRequest(ctx);
  }

  if (method === 'POST' && pathname === '/v0/node-rpc/session-attach') {
    return handleNodeSessionAttachRequest(ctx);
  }

  if (method === 'POST' && pathname === '/v0/node-rpc/session-command') {
    return handleNodeSessionCommandRequest(ctx);
  }

  if (method === 'POST' && pathname === '/v0/node-rpc/session-ack') {
    return handleNodeSessionAckRequest(ctx);
  }

  if (method === 'GET' && pathname === '/v0/node-rpc/session-run-events') {
    return handleNodeSessionRunEventsRequest(ctx);
  }

  if (method === 'GET' && pathname === '/v0/node-rpc/session-artifact') {
    return handleNodeSessionArtifactRequest(ctx);
  }

  if (method === 'POST' && pathname === '/v0/node-rpc/session-run-input') {
    return handleNodeSessionRunInputRequest(ctx);
  }

  if (method === 'POST' && pathname === '/v0/node-rpc/session-run-abort') {
    return handleNodeSessionRunAbortRequest(ctx);
  }

  writeNodeRpcNotFound(ctx);
  return true;
}

module.exports = {
  handleNodeRpcRequest
};
