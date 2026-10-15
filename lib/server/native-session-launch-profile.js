'use strict';

// 原生会话**启动档案**（Native Session Launch Profile）。
//
// 「这个 provider 的一轮怎么起」在两个既有描述符里已经声明过，本模块是它们的**唯一派生点**：
//
//   native-session-chat-transport.js  —— 执行模式与 prompt 投递方式（mode / promptDelivery）
//   chat-runner-profile.js            —— 每 provider 的运行事实（抑制交互提示 / 透传原始 stdout /
//                                        阶段完成语义 / 生图走网关 / sessionIndex 补写）
//
// 为什么要有这一层：消费方（canonical 驱动、未来的其它入口）**不应该**自己判 provider，也不应该
// 把 `interactiveCli` 之类写死。档案把「数据 → 启动形态」的映射集中在一处：
//   - 模式 → 启动形态用表（MODE_LAUNCH_FORMS），新增模式 = 加一行
//   - 步骤（启动前/启动后）也是数据（preparation / postSpawn），由准备管线按 id 执行
//   - 新增 provider 通常只是「在既有两张表里加一行」，本模块与消费方都不用改
//
// 与 legacy 路由的语义逐条对齐（webui-chat-routes.js 的 useHeadlessStream/nativeCliInteractive/
// initialInput 推导），避免两条链各说各话。

const { resolveNativeChatTransport } = require('./native-session-chat-transport');
const {
  getChatRunnerProfile,
  shouldCompleteOnTranscriptUpdate,
  shouldStreamRawStdout,
  shouldSuppressInteractivePrompt,
  shouldUseGatewayForImageModels
} = require('./chat-runner-profile');

// 执行模式 → 启动形态。表驱动：新增模式只加一行，不写 if/else。
//   interactiveCli = 用 PTY 承载（引擎的 run 包在 tmux 里，非 PTY 的 provider 拿不到 TTY；
//   agy 的 `--print` 就依赖 TTY）。prompt 投递为 typed 的 provider 无论模式如何都必须 PTY。
// 2026-10-15 实测教训：把 agy 从 PTY 改成非 PTY 后它在 tmux 里挂住不退（缺 TTY）；
// 真正的病根是当时**缺默认模型**（CLI 停在模型选择上），不是 PTY。
const MODE_LAUNCH_FORMS = Object.freeze({
  'headless-stream': Object.freeze({ headlessStream: true, interactiveCli: false, desktopSession: false }),
  'pty-transcript': Object.freeze({ headlessStream: false, interactiveCli: true, desktopSession: false }),
  'desktop-session': Object.freeze({ headlessStream: false, interactiveCli: false, desktopSession: true })
});

// prompt 投递通道：typed 表示 CLI 没有 argv 形态的 prompt 入口（必须敲进 TTY）。
const PROMPT_CHANNEL_FORMS = Object.freeze({
  argv: Object.freeze({ interactiveCli: false }),
  typed: Object.freeze({ interactiveCli: true })
});

const DEFAULT_MODE = 'pty-transcript';
const PROMPT_CHANNELS = Object.freeze({ ARGV: 'argv', TYPED: 'typed' });

// 启动前的准备步骤 id（实现见 native-session-launch-preparation）。
const PREPARE_SESSION_STORE_LINKS = 'session-store-links';
// 启动后的收尾步骤 id（会话 id 已知后执行，best effort）。
const POST_SPAWN_SESSION_INDEX = 'session-index';

function normalizeProvider(provider) {
  return String(provider || '').trim().toLowerCase();
}

function modeLaunchForm(mode) {
  return MODE_LAUNCH_FORMS[String(mode || '').trim()] || MODE_LAUNCH_FORMS[DEFAULT_MODE];
}

/**
 * 解析一个 provider 的启动档案。
 *
 * @param {string} providerRaw
 * @param {{isResume?: boolean}} [context] isResume = 续接已有原生会话（cline 的续聊语义不同）
 */
function resolveNativeSessionLaunchProfile(providerRaw, context = {}) {
  const provider = normalizeProvider(providerRaw);
  const isResume = context.isResume === true;
  const transport = resolveNativeChatTransport(provider, { isResume });
  const form = modeLaunchForm(transport.mode);
  const promptChannel = transport.promptDelivery === PROMPT_CHANNELS.TYPED
    ? PROMPT_CHANNELS.TYPED
    : PROMPT_CHANNELS.ARGV;
  const channelForm = PROMPT_CHANNEL_FORMS[promptChannel] || PROMPT_CHANNEL_FORMS.argv;
  const runnerProfile = getChatRunnerProfile(provider);
  return Object.freeze({
    provider,
    isResume,
    mode: transport.mode,
    promptDelivery: transport.promptDelivery,
    promptChannel,
    headlessStream: form.headlessStream,
    // 模式声明 PTY，或 prompt 必须敲进 TTY（typed）→ 用 PTY。
    interactiveCli: form.interactiveCli || channelForm.interactiveCli,
    desktopSession: form.desktopSession,
    suppressInteractivePrompt: shouldSuppressInteractivePrompt(provider),
    streamRawStdout: shouldStreamRawStdout(provider, { useTerminalMode: false }),
    // legacy 语义：仅非 headless 流式路径才用 transcript 阶段完成判定。
    completeOnTranscriptUpdate: shouldCompleteOnTranscriptUpdate(provider) && !form.headlessStream,
    gatewayForImageModels: shouldUseGatewayForImageModels(provider),
    // 步骤声明（数据）：启动前恒需 session-store 链接（handler 自己按 projectionRequired 判定是否需要），
    // 声明了 sessionIndex 的 provider 才在启动后补索引。
    preparation: Object.freeze([PREPARE_SESSION_STORE_LINKS]),
    postSpawn: Object.freeze(runnerProfile.sessionIndex ? [POST_SPAWN_SESSION_INDEX] : [])
  });
}

/**
 * 由档案派生引擎 spawn 参数（prompt 投递通道 + 形态旗标）。
 * 调用方只传 prompt，不需要知道 provider 该怎么投。
 */
function nativeSessionSpawnOptions(profile, input = {}) {
  const prompt = typeof input.prompt === 'string' ? input.prompt : '';
  const typed = profile.promptChannel === PROMPT_CHANNELS.TYPED;
  return {
    interactiveCli: profile.interactiveCli === true,
    prompt: typed ? '' : prompt,
    initialInput: typed ? prompt : '',
    suppressInteractivePrompt: profile.suppressInteractivePrompt === true,
    streamRawStdout: profile.streamRawStdout === true,
    completeOnTranscriptUpdate: profile.completeOnTranscriptUpdate === true
  };
}

module.exports = {
  MODE_LAUNCH_FORMS,
  POST_SPAWN_SESSION_INDEX,
  PREPARE_SESSION_STORE_LINKS,
  PROMPT_CHANNELS,
  nativeSessionSpawnOptions,
  resolveNativeSessionLaunchProfile
};
