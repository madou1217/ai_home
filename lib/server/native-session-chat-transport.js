'use strict';

const { FAMILY_PROVIDERS } = require('../runtime/codebuddy-family-layouts');

/**
 * 「WebUI 聊天的一轮怎么跑」的唯一声明处（descriptor，不散在路由里当 provider 名单）。
 *
 *   headless-stream  非交互 CLI + 结构化 JSON 流：stdout 逐行解析
 *                    （见 native-session-chat-stream 的 parseNativeStreamEvent）
 *   pty-transcript   交互式 PTY，本轮完成靠 transcript 轮询（gemini / agy / cline 的续聊）
 *   desktop-session  桌面端会话 runner（zcode）
 *
 * 每个 provider 声明：`mode`（普通轮）+ 可选 `resumeMode`（续聊轮，缺省 = mode）+
 * `promptDelivery`（argv 传 prompt，还是由 PTY 输入通道敲进去，缺省 argv）。
 *
 * cline 的两条实测事实（2026-10-15 本机，`cline 3.0.71`）决定了它的声明：
 *   1. `cline --json "<prompt>"` 非 TTY 下跑完即退，stdout 是 NDJSON agent 事件 → 新会话可 headless；
 *   2. `cline --id <session-id> …` **一律要求 TTY**（`--json`/`--yolo` 组合都报
 *      "interactive mode requires a TTY" 或 "JSON output mode requires a prompt argument"），
 *      即续聊只能进 TUI、prompt 必须敲进去 → resumeMode=pty-transcript + promptDelivery=typed。
 */

const DEFAULT_TRANSPORT = Object.freeze({ mode: 'pty-transcript', promptDelivery: 'argv' });

const TRANSPORT_BY_PROVIDER = Object.freeze({
  claude: Object.freeze({ mode: 'headless-stream', promptDelivery: 'argv' }),
  codex: Object.freeze({ mode: 'headless-stream', promptDelivery: 'argv' }),
  opencode: Object.freeze({ mode: 'headless-stream', promptDelivery: 'argv' }),
  qoder: Object.freeze({ mode: 'headless-stream', promptDelivery: 'argv' }),
  qodercn: Object.freeze({ mode: 'headless-stream', promptDelivery: 'argv' }),
  grok: Object.freeze({ mode: 'headless-stream', promptDelivery: 'argv' }),
  zcode: Object.freeze({ mode: 'desktop-session', promptDelivery: 'argv' }),
  cline: Object.freeze({
    mode: 'headless-stream',
    resumeMode: 'pty-transcript',
    promptDelivery: 'argv',
    resumePromptDelivery: 'typed'
  }),
  ...Object.fromEntries(FAMILY_PROVIDERS.map((provider) => [
    provider,
    Object.freeze({ mode: 'headless-stream', promptDelivery: 'argv' })
  ]))
});

// CLI 自己生成会话 id、进程退出后必须回认的 provider（机制在 inferCreatedSessionId 的分派里：
// agy 读 brain/<conversation-id>，cline 读 <CLINE_DATA_DIR>/db/sessions.db）。
const CLI_GENERATED_SESSION_ID_PROVIDERS = Object.freeze(['agy', 'cline']);

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

// 退出后是否需要回认 CLI 自己生成的会话 id。
function infersCliGeneratedSessionIdOnExit(provider) {
  return CLI_GENERATED_SESSION_ID_PROVIDERS.includes(normalizeProvider(provider));
}

module.exports = {
  TRANSPORT_BY_PROVIDER,
  CLI_GENERATED_SESSION_ID_PROVIDERS,
  resolveNativeChatTransport,
  usesHeadlessNativeStream,
  typesPromptIntoTerminal,
  infersCliGeneratedSessionIdOnExit
};
