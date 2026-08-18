/**
 * 此文件由 `go run ./cmd/provider-manifest` 自动生成。
 * 人工修改会在 Provider 合同校验中失败；请编辑 `core/providers/builtins.go`。
 */

export const PROVIDER_DEFINITIONS = [
  {
    "id": "codex",
    "label": "ChatGPT",
    "short": "GPT",
    "terminalIcon": "◎",
    "terminalIconAsset": "assets/provider-icons/codex.png",
    "accentVar": "var(--provider-codex)",
    "softVar": "var(--provider-codex-soft)",
    "tagColor": "green",
    "capabilities": [
      "api_key_account",
      "model_catalog",
      "quota_usage",
      "session_runtime",
      "fabric_runtime",
      "gateway_profile",
      "session_history",
      "usage_scan"
    ],
    "authOptions": [
      {
        "value": "oauth-browser",
        "label": "ChatGPT / OpenAI 登录",
        "description": "打开授权链接，授权后把回调地址提交给 WebUI。"
      },
      {
        "value": "oauth-device",
        "label": "设备码登录",
        "description": "仅在账号支持 device auth 时使用，适合远程环境。"
      },
      {
        "value": "api-key",
        "label": "OpenAI 密钥",
        "description": "绑定 OPENAI_API_KEY / OPENAI_BASE_URL。"
      }
    ],
    "clients": {
      "cli": true,
      "desktop": true
    }
  },
  {
    "id": "gemini",
    "label": "Gemini",
    "short": "GM",
    "terminalIcon": "✦",
    "terminalIconAsset": "assets/provider-icons/gemini.png",
    "accentVar": "var(--provider-gemini)",
    "softVar": "var(--provider-gemini-soft)",
    "tagColor": "blue",
    "capabilities": [
      "api_key_account",
      "model_catalog",
      "quota_usage",
      "fabric_runtime",
      "session_history",
      "usage_scan"
    ],
    "authOptions": [
      {
        "value": "oauth-browser",
        "label": "Google 登录 (已停用)",
        "description": "Google 已关闭 Gemini CLI 个人版登录，请改用 Gemini API Key 或 Antigravity。",
        "disabled": true,
        "disabledReason": "Google 已关闭 Gemini CLI 个人版登录，请改用 Gemini API Key 或 Antigravity"
      },
      {
        "value": "api-key",
        "label": "Gemini 密钥",
        "description": "绑定 GEMINI_API_KEY 或 GOOGLE_API_KEY。"
      },
      {
        "value": "vertex-ai",
        "label": "Vertex AI",
        "description": "Google Cloud Vertex AI 认证 (暂未接入，先占位)。"
      }
    ],
    "clients": {
      "cli": true,
      "desktop": false
    }
  },
  {
    "id": "claude",
    "label": "Claude",
    "short": "CL",
    "terminalIcon": "◇",
    "terminalIconAsset": "assets/provider-icons/claude.png",
    "accentVar": "var(--provider-claude)",
    "softVar": "var(--provider-claude-soft)",
    "tagColor": "orange",
    "capabilities": [
      "api_key_account",
      "model_catalog",
      "quota_usage",
      "session_runtime",
      "fabric_runtime",
      "gateway_profile",
      "session_history",
      "usage_scan"
    ],
    "authOptions": [
      {
        "value": "oauth-browser",
        "label": "Claude 登录",
        "description": "使用 Claude Code 原生 login 流程（Claude.ai 凭据）。"
      },
      {
        "value": "api-key",
        "label": "Anthropic 密钥",
        "description": "绑定 ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL。"
      },
      {
        "value": "auth-token",
        "label": "Claude Code Token",
        "description": "绑定 ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL。"
      }
    ],
    "clients": {
      "cli": true,
      "desktop": true
    }
  },
  {
    "id": "agy",
    "label": "Antigravity",
    "short": "AGY",
    "terminalIcon": "▲",
    "terminalIconAsset": "assets/provider-icons/agy.png",
    "accentVar": "var(--provider-agy)",
    "softVar": "var(--provider-agy-soft)",
    "tagColor": "purple",
    "capabilities": [
      "model_catalog",
      "quota_usage",
      "session_runtime",
      "fabric_runtime",
      "session_history",
      "usage_scan"
    ],
    "authOptions": [
      {
        "value": "oauth-browser",
        "label": "Antigravity 登录",
        "description": "使用 Antigravity CLI 原生 Google 登录流程。"
      }
    ],
    "clients": {
      "cli": true,
      "desktop": true
    }
  },
  {
    "id": "opencode",
    "label": "OpenCode",
    "short": "OC",
    "terminalIcon": "⌘",
    "terminalIconAsset": "assets/provider-icons/opencode.png",
    "accentVar": "var(--provider-opencode)",
    "softVar": "var(--provider-opencode-soft)",
    "tagColor": "default",
    "capabilities": [
      "model_catalog",
      "session_runtime",
      "fabric_runtime",
      "gateway_profile",
      "session_history",
      "usage_scan"
    ],
    "authOptions": [
      {
        "value": "oauth-browser",
        "label": "OpenCode 登录",
        "description": "使用 OpenCode CLI 原生 auth login 流程。"
      }
    ],
    "clients": {
      "cli": true,
      "desktop": true
    }
  },
  {
    "id": "grok",
    "label": "Grok",
    "short": "GK",
    "terminalIcon": "⚡",
    "terminalIconAsset": "assets/provider-icons/grok.png",
    "accentVar": "var(--provider-grok)",
    "softVar": "var(--provider-grok-soft)",
    "tagColor": "cyan",
    "capabilities": [
      "api_key_account",
      "model_catalog",
      "session_history",
      "account_session_store"
    ],
    "authOptions": [
      {
        "value": "api-key",
        "label": "xAI 密钥",
        "description": "绑定 XAI_API_KEY / XAI_BASE_URL。"
      },
      {
        "value": "oauth-browser",
        "label": "Grok 登录",
        "description": "使用 Grok Build CLI 原生 auth login 流程（需 SuperGrok 订阅）。"
      }
    ],
    "clients": {
      "cli": true,
      "desktop": false
    }
  },
  {
    "id": "qoder",
    "label": "Qoder",
    "short": "QD",
    "terminalIcon": "◆",
    "terminalIconAsset": "assets/provider-icons/qoder.png",
    "accentVar": "var(--provider-qoder)",
    "softVar": "var(--provider-qoder-soft)",
    "tagColor": "blue",
    "capabilities": [
      "model_catalog",
      "session_history",
      "account_session_store"
    ],
    "authOptions": [
      {
        "value": "oauth-browser",
        "label": "Qoder 登录",
        "description": "使用 Qoder CLI 原生 browser login 流程（全球站 qodercli）。"
      },
      {
        "value": "api-key",
        "label": "Qoder Personal Access Token",
        "description": "绑定 QODER_PERSONAL_ACCESS_TOKEN（全球站）。"
      }
    ],
    "clients": {
      "cli": true,
      "desktop": true
    }
  },
  {
    "id": "qodercn",
    "label": "Qoder CN",
    "short": "QCN",
    "terminalIcon": "◇",
    "terminalIconAsset": "assets/provider-icons/qodercn.png",
    "accentVar": "var(--provider-qodercn)",
    "softVar": "var(--provider-qodercn-soft)",
    "tagColor": "purple",
    "capabilities": [
      "model_catalog",
      "session_history",
      "account_session_store"
    ],
    "authOptions": [
      {
        "value": "oauth-browser",
        "label": "Qoder CN 登录",
        "description": "使用 Qoder CLI CN 原生 browser login 流程（qoderclicn）。"
      },
      {
        "value": "api-key",
        "label": "Qoder CN Personal Access Token",
        "description": "绑定 QODER_PERSONAL_ACCESS_TOKEN（国内站）。"
      }
    ],
    "clients": {
      "cli": true,
      "desktop": true
    }
  },
  {
    "id": "kimi",
    "label": "Kimi",
    "short": "KM",
    "terminalIcon": "☾",
    "terminalIconAsset": "assets/provider-icons/kimi.png",
    "accentVar": "var(--provider-kimi)",
    "softVar": "var(--provider-kimi-soft)",
    "tagColor": "geekblue",
    "capabilities": [
      "api_key_account",
      "model_catalog",
      "quota_usage",
      "usage_scan"
    ],
    "authOptions": [
      {
        "value": "api-key",
        "label": "Moonshot 密钥",
        "description": "绑定 MOONSHOT_API_KEY / KIMI_BASE_URL（支持 api.moonshot.cn 和 api.moonshot.ai 双端点）。"
      },
      {
        "value": "oauth-browser",
        "label": "Kimi Code 登录",
        "description": "使用 Kimi Code CLI 原生 OAuth 设备码流程（需 Kimi 会员订阅）。"
      }
    ],
    "clients": {
      "cli": true,
      "desktop": false
    }
  },
  {
    "id": "kiro",
    "label": "Kiro",
    "short": "KR",
    "terminalIcon": "⬡",
    "terminalIconAsset": "assets/provider-icons/kiro.png",
    "accentVar": "var(--provider-kiro)",
    "softVar": "var(--provider-kiro-soft)",
    "tagColor": "volcano",
    "capabilities": [
      "model_catalog",
      "session_history",
      "account_session_store"
    ],
    "authOptions": [
      {
        "value": "oauth-browser",
        "label": "AWS Builder ID 登录",
        "description": "使用 Kiro CLI Device Flow 认证（支持 Google/GitHub/AWS Builder ID）。"
      }
    ],
    "clients": {
      "cli": true,
      "desktop": true
    }
  },
  {
    "id": "zcode",
    "label": "ZCode",
    "short": "ZC",
    "terminalIcon": "◈",
    "terminalIconAsset": "assets/provider-icons/zcode.png",
    "accentVar": "var(--provider-zcode)",
    "softVar": "var(--provider-zcode-soft)",
    "tagColor": "geekblue",
    "capabilities": [
      "api_key_account",
      "model_catalog",
      "session_history",
      "quota_usage"
    ],
    "authOptions": [
      {
        "value": "oauth-browser",
        "label": "ZCode 登录",
        "description": "使用 ZCode Desktop 的官方浏览器 OAuth 流程（Z.AI 账号，OAuth 凭据安全写入 AIH）。"
      },
      {
        "value": "api-key",
        "label": "Z.ai 密钥",
        "description": "绑定 ZCODE_API_KEY / ZCODE_BASE_URL（支持 open.bigmodel.cn 与 api.z.ai 双 Anthropic 端点）。"
      }
    ],
    "clients": {
      "cli": false,
      "desktop": true
    }
  }
];

export const PROVIDER_IDS = Object.freeze(PROVIDER_DEFINITIONS.map((definition) => definition.id));

export const PROVIDER_CATALOG = Object.freeze(Object.fromEntries(
  PROVIDER_DEFINITIONS.map((definition) => [definition.id, {
    id: definition.id,
    label: definition.label,
    short: definition.short,
    terminalIcon: definition.terminalIcon,
    terminalIconAsset: definition.terminalIconAsset,
    accentVar: definition.accentVar,
    softVar: definition.softVar,
    tagColor: definition.tagColor,
    capabilities: definition.capabilities,
    clients: definition.clients,
  }]),
));

export const PROVIDER_AUTH_OPTIONS = Object.freeze(Object.fromEntries(
  PROVIDER_DEFINITIONS.map((definition) => [definition.id, definition.authOptions]),
));

export const PROVIDER_FALLBACK = {
  "id": "codex",
  "label": "AI",
  "short": "AI",
  "terminalIcon": "◌",
  "terminalIconAsset": "web/src/assets/brand/ai-home-mark.png",
  "accentVar": "var(--color-brand)",
  "softVar": "var(--color-brand-soft)",
  "tagColor": "blue",
  "capabilities": [],
  "clients": {
    "cli": false,
    "desktop": false
  }
};
