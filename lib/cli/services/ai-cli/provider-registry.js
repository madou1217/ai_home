'use strict';

const AI_CLI_CONFIGS = Object.freeze({
  agy: Object.freeze({
    globalDir: '.gemini',
    configSubDir: 'antigravity-cli',
    loginArgs: Object.freeze([]),
    pkg: '',
    envKeys: Object.freeze(['AGY_ACCESS_TOKEN', 'GOOGLE_OAUTH_ACCESS_TOKEN']),
    desktopClient: Object.freeze({
      macos: Object.freeze({
        clientName: 'Antigravity',
        execNames: Object.freeze(['Antigravity']),
        pathIncludes: Object.freeze(['/Antigravity.app/Contents/MacOS/']),
        installPaths: Object.freeze([
          '/Applications/Antigravity.app',
          '{hostHomeDir}/Applications/Antigravity.app'
        ])
      }),
      windows: Object.freeze({
        clientName: 'Antigravity',
        processNames: Object.freeze(['Antigravity.exe']),
        execNames: Object.freeze(['Antigravity.exe'])
      }),
      linux: Object.freeze({
        clientName: 'Antigravity',
        execNames: Object.freeze(['antigravity', 'agy'])
      })
    })
  }),
  gemini: Object.freeze({
    globalDir: '.gemini',
    loginArgs: Object.freeze(['auth']),
    pkg: '@google/gemini-cli',
    envKeys: Object.freeze(['GEMINI_API_KEY', 'GOOGLE_API_KEY']),
    desktopClient: Object.freeze({
      macos: Object.freeze({
        clientName: 'Gemini',
        execNames: Object.freeze(['Gemini']),
        pathIncludes: Object.freeze(['/Gemini.app/Contents/MacOS/']),
        installPaths: Object.freeze([
          '/Applications/Gemini.app',
          '{hostHomeDir}/Applications/Gemini.app'
        ])
      }),
      windows: Object.freeze({
        clientName: 'Gemini',
        processNames: Object.freeze(['Gemini.exe']),
        execNames: Object.freeze(['Gemini.exe'])
      }),
      linux: Object.freeze({
        clientName: 'Gemini',
        execNames: Object.freeze(['Gemini', 'gemini-desktop'])
      })
    })
  }),
  claude: Object.freeze({
    // `claude login` was removed in Claude Code v2.x; the OAuth flow is now
    // `claude setup-token`, which prints the authorization URL and reads back a
    // pasted code. The old value made `claude login` start an interactive
    // session with "login" as a prompt, so authorization never began.
    globalDir: '.claude',
    loginArgs: Object.freeze(['setup-token']),
    pkg: '@anthropic-ai/claude-code',
    envKeys: Object.freeze(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']),
    desktopClient: Object.freeze({
      macos: Object.freeze({
        clientName: 'Claude',
        execNames: Object.freeze(['Claude']),
        pathIncludes: Object.freeze(['/Claude.app/Contents/MacOS/']),
        installPaths: Object.freeze([
          '/Applications/Claude.app',
          '{hostHomeDir}/Applications/Claude.app'
        ])
      }),
      windows: Object.freeze({
        clientName: 'Claude',
        processNames: Object.freeze(['Claude.exe']),
        execNames: Object.freeze(['Claude.exe'])
      }),
      linux: Object.freeze({
        clientName: 'Claude',
        execNames: Object.freeze(['Claude', 'claude-desktop'])
      })
    })
  }),
  codex: Object.freeze({
    globalDir: '.codex',
    loginArgs: Object.freeze(['login']),
    pkg: '@openai/codex',
    envKeys: Object.freeze(['OPENAI_API_KEY', 'OPENAI_BASE_URL']),
    desktopClient: Object.freeze({
      macos: Object.freeze({
        clientName: 'Codex',
        execNames: Object.freeze(['ChatGPT', 'Codex']),
        pathIncludes: Object.freeze([
          '/ChatGPT.app/Contents/MacOS/',
          '/Codex.app/Contents/MacOS/'
        ]),
        bundleId: 'com.openai.codex',
        installPaths: Object.freeze([
          '/Applications/ChatGPT.app',
          '{hostHomeDir}/Applications/ChatGPT.app',
          '/Applications/Codex.app',
          '{hostHomeDir}/Applications/Codex.app'
        ])
      }),
      windows: Object.freeze({
        clientName: 'Codex',
        processNames: Object.freeze(['Codex.exe']),
        execNames: Object.freeze(['Codex.exe'])
      }),
      linux: Object.freeze({
        clientName: 'Codex',
        execNames: Object.freeze(['Codex', 'codex-desktop', 'codex-app'])
      })
    })
  }),
  opencode: Object.freeze({
    globalDir: '.config/opencode',
    loginArgs: Object.freeze(['auth', 'login']),
    pkg: 'opencode-ai',
    // OpenCode owns credential collection (`opencode auth login`). AIH captures
    // auth.json into app-state.db and materializes an account projection at launch;
    // config, cache and OpenCode's own operational DB remain host-shared.
    envKeys: Object.freeze([]),
    desktopClient: Object.freeze({
      macos: Object.freeze({
        clientName: 'OpenCode',
        execNames: Object.freeze(['OpenCode']),
        pathIncludes: Object.freeze(['/OpenCode.app/Contents/MacOS/']),
        installPaths: Object.freeze([
          '/Applications/OpenCode.app',
          '{hostHomeDir}/Applications/OpenCode.app'
        ])
      }),
      windows: Object.freeze({
        clientName: 'OpenCode',
        processNames: Object.freeze(['OpenCode.exe']),
        execNames: Object.freeze(['OpenCode.exe'])
      }),
      linux: Object.freeze({
        clientName: 'OpenCode',
        execNames: Object.freeze(['OpenCode', 'opencode-desktop'])
      })
    })
  })
});

function getAiCliConfig(cliName) {
  return AI_CLI_CONFIGS[String(cliName || '').trim()] || null;
}

function isSupportedAiCli(cliName) {
  return !!getAiCliConfig(cliName);
}

function listSupportedAiClis() {
  return Object.keys(AI_CLI_CONFIGS);
}

module.exports = {
  AI_CLI_CONFIGS,
  getAiCliConfig,
  isSupportedAiCli,
  listSupportedAiClis
};
