'use strict';

// Compatibility exports only: the local WebSocket, rewrite, response contexts,
// backpressure and connection lifetime now run in the native Go helper.
const { patchThreadResumeResponse, patchThreadResumeResponseMessage } = require('./codex-thread-resume-response-patch');
const { startNativeCodexResumeProxy } = require('./codex-resume-proxy-launcher');

module.exports = {
  patchCodexCliResumeServerMessage: patchThreadResumeResponseMessage,
  patchThreadResumeResponse,
  startCodexCliResumeCwdProxy: startNativeCodexResumeProxy
};
