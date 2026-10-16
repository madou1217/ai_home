'use strict';

const { FAMILY_PROVIDERS } = require('../runtime/codebuddy-family-layouts');

/**
 * 「WebUI 聊天的一轮怎么跑」的唯一声明处（descriptor，不散在路由里当 provider 名单）。
 *
 *   headless-stream  非交互 CLI + 结构化 JSON 流：stdout 逐行解析
 *                    （见 native-session-chat-stream 的 parseNativeStreamEvent）
 *   pty-transcript   交互式 PTY，本轮完成靠 transcript 轮询（gemini / agy 的续聊）
 *   acp-session      ACP 协议通道（stdio NDJSON JSON-RPC）：session/load + session/prompt，
 *                    delta 流式、无 TTY、无敲入；完成仍靠 transcript 收尾
 *                    （见 lib/server/acp-session-runner.js）
 *   desktop-session  桌面端会话 runner（zcode）
 *
 * 每个 provider 声明：`mode`（普通轮）+ 可选 `resumeMode`（续聊轮，缺省 = mode）+
 * `promptDelivery`（argv 传 prompt，还是由 PTY 输入通道敲进去，缺省 argv）。
 *
 * cline 的三条实测事实（2026-10-15/16 本机，`cline 3.0.71`）决定了它的声明：
 *   1. `cline --json "<prompt>"` 非 TTY 下跑完即退，stdout 是 NDJSON agent 事件 → 新会话可 headless；
 *   2. `cline --id <session-id> …` **一律要求 TTY**（`--json`/`--yolo` 组合都报
 *      "interactive mode requires a TTY" 或 "JSON output mode requires a prompt argument"）；
 *   3. TUI 续聊不可用于服务端注入：spawn 后立即敲入的 prompt 会被启动期吞掉（输入框停在
 *      空占位、整轮消失；延迟 8s 再敲才成功）——「等就绪再敲」的时序启发式不可靠。
 *      因此续聊改走 ACP（`cline --acp`）：session/load 续接同一会话 + session/prompt
 *      带 prompt，流式 delta、确定性 stopReason → resumeMode=acp-session。
 */

const DEFAULT_TRANSPORT = Object.freeze({ mode: 'pty-transcript', promptDelivery: 'argv' });

const TRANSPORT_BY_PROVIDER = Object.freeze({
  claude: Object.freeze({ mode: 'headless-stream', promptDelivery: 'argv', tmuxRun: true }),
  codex: Object.freeze({ mode: 'headless-stream', promptDelivery: 'argv', tmuxRun: true }),
  opencode: Object.freeze({ mode: 'headless-stream', promptDelivery: 'argv', tmuxRun: true }),
  qoder: Object.freeze({ mode: 'headless-stream', promptDelivery: 'argv' }),
  qodercn: Object.freeze({ mode: 'headless-stream', promptDelivery: 'argv' }),
  grok: Object.freeze({ mode: 'headless-stream', promptDelivery: 'argv' }),
  zcode: Object.freeze({ mode: 'desktop-session', promptDelivery: 'argv' }),
  cline: Object.freeze({
    mode: 'headless-stream',
    // 续聊走 ACP 协议通道（`cline --acp`，见 lib/server/acp-session-runner.js）；
    // TUI 形态（pty-transcript + typed 注入）实测会被启动期输入吞掉，2026-10-16 弃用。
    resumeMode: 'acp-session',
    promptDelivery: 'argv'
  }),
  // agy：新会话是 headless `--print`（一次性命令，输出即答案）→ tmux 化 run；
  // 续接走 TUI（`--conversation`）→ pty-transcript（interactiveCli 短路到 node-pty）。
  agy: Object.freeze({
    mode: 'pty-transcript',
    promptDelivery: 'argv',
    tmuxRun: true
  }),
  ...Object.fromEntries(FAMILY_PROVIDERS.map((provider) => [
    provider,
    Object.freeze({ mode: 'headless-stream', promptDelivery: 'argv' })
  ]))
});

// CLI 自己生成会话 id、进程退出后必须回认的 provider（机制在 inferCreatedSessionId 的分派里：
// agy 读 brain/<conversation-id>，cline 读 <CLINE_DATA_DIR>/db/sessions.db）。
const CLI_GENERATED_SESSION_ID_PROVIDERS = Object.freeze(['agy', 'cline']);

// 「非交互轮次用 tmux 化 run（进程生命周期与 server 脱钩 + 退出标记）还是 node-pty」是每 provider
// 的事实，因此在这里声明（`tmuxRun`），由 usesTmuxRun / tmuxRunProviders 派生消费方需要的集合 ——
// 不再由调用方维护一份 provider 名单。
//   2026-10-15 实测：agy 的 `--print` 新会话在 node-pty 下会挂住不退（同 argv/env/投影下，
//   tmux 化 run 正常完成并写出退出标记）。原实现用写死的 {claude,codex,opencode} 名单，
//   agy 因此永远走 PTY → 卡死。
// 交互式轮次（slash / resume 的 TUI）始终走 node-pty：见 resolveNativeRunMultiplexer 的
// `interactiveCli` 短路，以及本表的 mode/resumeMode 声明。

function normalizeProvider(provider) {
  return String(provider || '').trim().toLowerCase();
}

/**
 * @param {string} provider
 * @param {{isResume?: boolean}} [context]
 * @returns {{mode: string, promptDelivery: string}}
 */
function resolveNativeChatTransport(provider, context = {}) {
  const declared = TRANSPORT_BY_PROVIDER[normalizeProvider(provider)] || DEFAULT_TRANSPORT;
  const isResume = context.isResume === true;
  return {
    mode: isResume && declared.resumeMode ? declared.resumeMode : declared.mode,
    promptDelivery: isResume && declared.resumePromptDelivery
      ? declared.resumePromptDelivery
      : declared.promptDelivery
  };
}

// 这一轮是不是「非交互 CLI + 结构化 JSON 流」。
function usesHeadlessNativeStream(provider, context = {}) {
  return resolveNativeChatTransport(provider, context).mode === 'headless-stream';
}

// prompt 是否必须由 PTY 输入通道敲进去（CLI 没有 argv 形态的 prompt 入口）。
function typesPromptIntoTerminal(provider, context = {}) {
  return resolveNativeChatTransport(provider, context).promptDelivery === 'typed';
}

// 非交互轮次用 tmux 化 run 的 provider（由描述符的 `tmuxRun` 派生 —— 不再由调用方维护名单）。
function usesTmuxRun(provider) {
  return TRANSPORT_BY_PROVIDER[normalizeProvider(provider)]?.tmuxRun === true;
}

function tmuxRunProviders() {
  return Object.keys(TRANSPORT_BY_PROVIDER).filter((provider) => usesTmuxRun(provider));
}

// 退出后是否需要回认 CLI 自己生成的会话 id。
function infersCliGeneratedSessionIdOnExit(provider) {
  return CLI_GENERATED_SESSION_ID_PROVIDERS.includes(normalizeProvider(provider));
}

module.exports = {
  TRANSPORT_BY_PROVIDER,
  CLI_GENERATED_SESSION_ID_PROVIDERS,
  resolveNativeChatTransport,
  tmuxRunProviders,
  typesPromptIntoTerminal,
  usesHeadlessNativeStream,
  usesTmuxRun,
  infersCliGeneratedSessionIdOnExit
};
