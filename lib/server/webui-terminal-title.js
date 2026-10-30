'use strict';

// WebUI session labels use the same title source registry as interactive CLI
// sessions. Keeping this facade server-side avoids a second provider-label map
// in the browser and makes future title sources available to both surfaces.
const { getTitleSourceRegistry } = require('../cli/services/pty/terminal-title/registry');

function normalize(value) {
  return String(value == null ? '' : value).trim();
}

function buildWebUiTerminalTitle(input = {}) {
  const registry = getTitleSourceRegistry();
  const frames = registry.collectFrames({
    provider: normalize(input.provider),
    accountId: normalize(input.accountId),
    model: normalize(input.model),
    sessionLabel: normalize(input.sessionLabel)
  });
  return normalize(frames[0]) || normalize(input.fallback) || 'Web Terminal';
}

module.exports = { buildWebUiTerminalTitle };
