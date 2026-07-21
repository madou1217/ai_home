'use strict';

const PROVIDER_NATIVE_CAPABILITIES = Object.freeze({
  codex: Object.freeze({
    provider: 'codex',
    config: Object.freeze({
      envHomeKeys: Object.freeze(['CODEX_HOME']),
      userSettings: Object.freeze(['config.toml']),
      projectSettings: Object.freeze(['.codex/config.toml']),
      cliFlags: Object.freeze(['--profile', '--config'])
    }),
    sessions: Object.freeze({
      flags: Object.freeze(['resume', 'fork']),
      nativeStore: 'state_*.sqlite'
    }),
    mcp: Object.freeze({
      commands: Object.freeze(['mcp']),
      configFiles: Object.freeze(['config.toml'])
    }),
    hooks: Object.freeze({
      files: Object.freeze(['hooks.json']),
      stopRequiresJsonStdout: true
    }),
    permissions: Object.freeze({
      flags: Object.freeze(['--sandbox', '--ask-for-approval']),
      modes: Object.freeze(['read-only', 'workspace-write', 'danger-full-access'])
    })
  }),
  claude: Object.freeze({
    provider: 'claude',
    config: Object.freeze({
      envHomeKeys: Object.freeze(['CLAUDE_CONFIG_DIR']),
      userSettings: Object.freeze(['settings.json']),
      projectSettings: Object.freeze(['.claude/settings.json', '.claude/settings.local.json']),
      cliFlags: Object.freeze(['--settings', '--setting-sources'])
    }),
    sessions: Object.freeze({
      flags: Object.freeze(['--continue', '--resume', '--session-id', '--fork-session']),
      nativeStore: 'projects/<project>/<session-id>.jsonl'
    }),
    mcp: Object.freeze({
      commands: Object.freeze(['mcp']),
      configFiles: Object.freeze(['.mcp.json', '.claude.json'])
    }),
    hooks: Object.freeze({
      files: Object.freeze(['settings.json', 'plugins/hooks.json']),
      stopRequiresJsonStdout: true
    }),
    permissions: Object.freeze({
      flags: Object.freeze(['--permission-mode', '--allowedTools', '--disallowedTools']),
      modes: Object.freeze(['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'])
    })
  }),
  gemini: Object.freeze({
    provider: 'gemini',
    config: Object.freeze({
      envHomeKeys: Object.freeze(['GEMINI_CLI_SYSTEM_SETTINGS_PATH']),
      userSettings: Object.freeze(['settings.json']),
      projectSettings: Object.freeze(['.gemini/settings.json']),
      cliFlags: Object.freeze(['--model', '--approval-mode', '--policy', '--admin-policy'])
    }),
    sessions: Object.freeze({
      flags: Object.freeze(['--resume', '--session-id', '--list-sessions']),
      nativeStore: 'sessions'
    }),
    mcp: Object.freeze({
      commands: Object.freeze(['mcp']),
      configFiles: Object.freeze(['settings.json'])
    }),
    hooks: Object.freeze({
      files: Object.freeze(['settings.json']),
      stopRequiresJsonStdout: true
    }),
    permissions: Object.freeze({
      flags: Object.freeze(['--approval-mode', '--policy', '--admin-policy']),
      modes: Object.freeze(['default', 'auto_edit', 'yolo', 'plan'])
    })
  }),
  agy: Object.freeze({
    provider: 'agy',
    config: Object.freeze({
      envHomeKeys: Object.freeze(['HOME']),
      userSettings: Object.freeze(['.gemini/antigravity-cli/settings.json']),
      projectSettings: Object.freeze(['.agents/settings.json']),
      cliFlags: Object.freeze(['--sandbox', '--conversation', '--continue'])
    }),
    sessions: Object.freeze({
      flags: Object.freeze(['--continue', '--conversation']),
      nativeStore: 'workspace-scoped conversations'
    }),
    mcp: Object.freeze({
      commands: Object.freeze(['/mcp']),
      configFiles: Object.freeze([
        '.gemini/antigravity-cli/mcp_config.json',
        '.agents/mcp_config.json'
      ])
    }),
    hooks: Object.freeze({
      files: Object.freeze([
        '.gemini/config/hooks.json',
        '.agents/hooks.json',
        '.gemini/config/plugins/*/hooks.json',
        '.gemini/antigravity-cli/plugins/*/hooks.json'
      ]),
      stopRequiresJsonStdout: true
    }),
    permissions: Object.freeze({
      flags: Object.freeze(['--sandbox', '--dangerously-skip-permissions']),
      modes: Object.freeze(['allow', 'ask', 'deny'])
    })
  }),
  grok: Object.freeze({
    provider: 'grok',
    config: Object.freeze({
      envHomeKeys: Object.freeze(['GROK_HOME']),
      userSettings: Object.freeze(['settings.json']),
      projectSettings: Object.freeze(['.grok/settings.json']),
      cliFlags: Object.freeze(['--model', '--plan'])
    }),
    sessions: Object.freeze({
      flags: Object.freeze(['--continue', '--conversation']),
      nativeStore: 'sessions'
    }),
    mcp: Object.freeze({
      commands: Object.freeze(['mcp']),
      configFiles: Object.freeze(['.grok/mcp.json'])
    }),
    hooks: Object.freeze({
      files: Object.freeze(['.grok/hooks.json']),
      stopRequiresJsonStdout: true
    }),
    permissions: Object.freeze({
      flags: Object.freeze(['--sandbox', '--dangerously-skip-permissions']),
      modes: Object.freeze(['default', 'plan', 'auto'])
    })
  })
});

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeProvider(value) {
  return String(value || '').trim().toLowerCase();
}

function getProviderNativeCapability(provider) {
  const capability = PROVIDER_NATIVE_CAPABILITIES[normalizeProvider(provider)];
  return capability ? cloneJson(capability) : null;
}

function listProviderNativeCapabilities() {
  return Object.keys(PROVIDER_NATIVE_CAPABILITIES)
    .sort()
    .map((provider) => getProviderNativeCapability(provider));
}

function buildProviderNativeCapabilityMap(providers) {
  return (Array.isArray(providers) ? providers : [])
    .reduce((acc, provider) => {
      const key = normalizeProvider(provider);
      const capability = getProviderNativeCapability(key);
      if (key && capability) acc[key] = capability;
      return acc;
    }, {});
}

module.exports = {
  PROVIDER_NATIVE_CAPABILITIES,
  buildProviderNativeCapabilityMap,
  getProviderNativeCapability,
  listProviderNativeCapabilities,
  __private: {
    normalizeProvider
  }
};
