'use strict';

// 非零客户端回退通道：`unix:/path` = 本机 socket，其余视为 URL。
const AGENT_ENDPOINT_ENV = 'AIH_SSH_CLIP_AGENT_ENDPOINT';

function parseAgentEndpoint(value) {
  const raw = String(value || '').trim();
  if (!raw) return {};
  if (raw.startsWith('unix:')) return { socketPath: raw.slice('unix:'.length) };
  return { url: raw };
}

module.exports = { AGENT_ENDPOINT_ENV, parseAgentEndpoint };
