'use strict';

const { createDesktopLaunchStrategy } = require('./default-strategy');
const { configureClaudeDesktopGateway } = require('../../cli/services/ai-cli/claude-desktop-inference');
const { readServerConfig } = require('../server-config-store');

const claudeDesktopLaunchStrategy = createDesktopLaunchStrategy({
  name: 'claude-native-gateway',
  hostLaunchLabel: '通过 AIH Server 打开',
  prepareHostLaunch(options) {
    const result = configureClaudeDesktopGateway({
      ...options,
      aiHomeDir: options.aiHomeDir,
      serverConfig: options.serverConfig || readServerConfig(options)
    });
    if (!result.ok) return { ready: false, error: 'claude_gateway_prepare_failed', reason: result.reason };
    return { ready: true, gatewayBaseUrl: result.gatewayBaseUrl };
  }
});

module.exports = { claudeDesktopLaunchStrategy };
