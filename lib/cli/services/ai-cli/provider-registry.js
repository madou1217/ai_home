'use strict';

const AI_CLI_CONFIGS = Object.freeze({
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
    globalDir: '.claude',
    loginArgs: Object.freeze(['login']),
    pkg: '@anthropic-ai/claude-code',
    envKeys: Object.freeze(['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL']),
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
        execNames: Object.freeze(['Codex']),
        pathIncludes: Object.freeze(['/Codex.app/Contents/MacOS/']),
        bundleId: 'com.openai.codex',
        installPaths: Object.freeze([
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
