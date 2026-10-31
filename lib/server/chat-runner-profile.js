'use strict';

// **WebUI chat 的 provider 运行档案**（Table-Driven Mapping + Strategy Table）。
//
// chat 路由要按 provider 回答几个「这台机器上怎么跑它」的问题：API Key 账号能否走 native CLI、
// 是否要抑制交互式提示抓取、审批桥要挂哪个常驻 runner、生图模型是否必须改走网关。这些差异
// 全是**每 provider 的事实**，因此注册成档案；路由层只调本模块的具名入口，不写 provider 名比较。
//
// 审批桥 runner id 与既有实现一一对应：
//   codex-app-server —— codex 的 app-server JSON-RPC（每账号常驻 + ws，审批经桥往返）
//   opencode-serve   —— opencode 的常驻 `opencode serve` HTTP API（会话级 ask 规则）

const CHAT_RUNNER_PROFILES = Object.freeze({
  codex: Object.freeze({
    // API Key 账号也能走 native：spawn 前 config-sync 生成 [model_providers]（env_key 形态）。
    apiKeyNativeReady: true,
    // 新会话若 rollout/DB 解析不出标题会被列表过滤：用本轮 prompt 补一条 session_index 条目。
    sessionIndex: 'codex-session-index',
    approvalBridgeRunner: 'codex-app-server',
    // API Key codex 会话在宿主 CODEX_HOME 里跑，需要宿主注册受管 provider 段。
    syncHostProfileOnApiKey: true,
    // 项目级 hook 与信任表要在起会话前补齐（否则 codex 不触发 hook）。
    bootstrapProjectHooks: true
  }),
  claude: Object.freeze({
    // claude 的 API Key 走 buildProviderEnv 注入 ANTHROPIC_AUTH_TOKEN/BASE_URL。
    apiKeyNativeReady: true
  }),
  agy: Object.freeze({
    // agy 用 `--print`，输出是干净模型回复，没有交互式菜单：关掉 interactive-prompt 抓取，
    // 避免回复里偶发的编号列表 / “press Enter” 被误判成需要确认的 prompt。
    suppressInteractivePrompt: true,
    // agy/gemini 的生图模型（如 gemini-3.1-flash-image）不具备 CLI 交互环境，必须走网关流式生图。
    gatewayForImageModels: true,
    // agy 的 transcript 更新是**阶段性**输出（PLANNER_RESPONSE），必须等进程退出才算本轮完成。
    completeOnTranscriptUpdate: false,
    // 同上：阶段性输出直接透传原始 stdout。
    streamRawStdout: true,
    // agy 存储无 cwd → 写 sessionId→projectPath 索引，项目列表据此收会话。
    sessionIndex: 'agy-project'
  }),
  gemini: Object.freeze({
    gatewayForImageModels: true,
    // API Key / Vertex 账号：buildProviderEnv 把账号库字段映射成 CLI 变量（geminiCliEndpointEnv），
    // ACP 显式 authenticate（gemini-strategy.resolveAcpAuthMethod）。2026-10-31 真机：Vertex 账号经网关跑通。
    apiKeyNativeReady: true
  }),
  opencode: Object.freeze({
    // opencode 的 headless run（--dangerously-skip-permissions）没有权限回路，审批桥走常驻 serve。
    approvalBridgeRunner: 'opencode-serve'
  })
});

const EMPTY_PROFILE = Object.freeze({});

function getChatRunnerProfile(providerRaw) {
  const provider = String(providerRaw || '').trim().toLowerCase();
  return CHAT_RUNNER_PROFILES[provider] || EMPTY_PROFILE;
}

function isApiKeyNativeReady(provider) {
  return getChatRunnerProfile(provider).apiKeyNativeReady === true;
}

function shouldSuppressInteractivePrompt(provider) {
  return getChatRunnerProfile(provider).suppressInteractivePrompt === true;
}

function shouldUseGatewayForImageModels(provider) {
  return getChatRunnerProfile(provider).gatewayForImageModels === true;
}

function shouldSyncHostProfileOnApiKey(provider) {
  return getChatRunnerProfile(provider).syncHostProfileOnApiKey === true;
}

function shouldBootstrapProjectHooks(provider) {
  return getChatRunnerProfile(provider).bootstrapProjectHooks === true;
}

// 阶段性 transcript 是否直接透传原始 stdout（agy 是；终端模式除外）。
function shouldStreamRawStdout(provider, { useTerminalMode } = {}) {
  return getChatRunnerProfile(provider).streamRawStdout === true && !useTerminalMode;
}

// transcript 首次更新能否提前结束本轮：agy 不能（PLANNER_RESPONSE 只是阶段性输出）。
function shouldCompleteOnTranscriptUpdate(provider) {
  return getChatRunnerProfile(provider).completeOnTranscriptUpdate !== false;
}

// 新会话的索引补写（best effort，绝不抛出）：让列表能看见刚建的会话。
// 依赖 native-session-chat，因此惰性 require（避免与 chat 主链形成加载环）。
function ensureSessionIndexEntry(provider, { sessionId, prompt, projectPath } = {}) {
  const kind = getChatRunnerProfile(provider).sessionIndex;
  if (!kind || !sessionId) return;
  try {
    const chat = require('./native-session-chat');
    if (kind === 'codex-session-index') {
      chat.ensureCodexSessionIndexEntry({ sessionId, prompt });
      return;
    }
    if (kind === 'agy-project' && projectPath) {
      chat.ensureAgySessionProjectIndex({ sessionId, projectPath });
    }
  } catch (_error) {
    // best effort
  }
}

// 审批桥 runner：只有 headless 流式路径 + 审批模式需要桥时才启用，bypass 模式保持原路径零变化。
function resolveApprovalBridgeRunner(provider, { useHeadlessStream, needsBridge } = {}) {
  if (!useHeadlessStream || !needsBridge) return '';
  return getChatRunnerProfile(provider).approvalBridgeRunner || '';
}

module.exports = {
  ensureSessionIndexEntry,
  getChatRunnerProfile,
  isApiKeyNativeReady,
  resolveApprovalBridgeRunner,
  shouldBootstrapProjectHooks,
  shouldCompleteOnTranscriptUpdate,
  shouldStreamRawStdout,
  shouldSuppressInteractivePrompt,
  shouldSyncHostProfileOnApiKey,
  shouldUseGatewayForImageModels
};
