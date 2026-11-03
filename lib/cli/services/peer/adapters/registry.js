'use strict';

// 每个 harness 的跨会话能力：一张**显式**的表，不留「其它 provider 走默认」的暗门。
//
// 为什么强制逐条登记：2026-11-02 的结论是「除 claude 外没有本机通道」，但那句话会随
// 版本漂移（opencode 有本地 server、codex 有 app-server、codebuddy 家族有服务端
// teammate/channel）。把每个 provider 的能力写成数据，add 新 provider 时补全表就会
// 被 test/peer-messaging.test.js 的矩阵断言挡住——而不是悄悄回落到注入。
//
// channel 的含义（HARNESS_CHANNELS 是「这个 harness 用哪条通道」，PEER_CHANNELS 是
// 「有哪些通道、各自怎么投递」）：
//   native      本机有协议端点（现在只有 claude 的 UDS）
//   inject      只能由 aih 代打进 pane（等价用户手打）
//   webui-chat  chat runtime 的命令总线（不是 harness，按 runtime 而非 provider 分）
//   none        连 aih 会话都没有（不该出现；出现说明 provider 不能跑持久会话）

const claudeUds = require('./claude-uds');

const HARNESS_CHANNELS = Object.freeze([
  Object.freeze({
    provider: 'claude',
    label: 'Claude Code',
    channel: 'native',
    adapter: 'claude-uds',
    note: '本机 UDS：sessions/<pid>.json 发现 + cc-socks 收件箱，有投递/挂起语义'
  }),
  Object.freeze({
    provider: 'codebuddy',
    label: 'CodeBuddy',
    channel: 'inject',
    adapter: 'tmux-inject',
    note: 'teammate/channel 在服务端，本机没有 socket；经 aih 注入'
  }),
  Object.freeze({
    provider: 'codebuddycn',
    label: 'CodeBuddy CN',
    channel: 'inject',
    adapter: 'tmux-inject',
    note: 'codebuddy 家族的服务端 teammate；本机没有 socket，经 aih 注入'
  }),
  Object.freeze({
    provider: 'workbuddy',
    label: 'WorkBuddy',
    channel: 'inject',
    adapter: 'tmux-inject',
    note: 'codebuddy 家族内核；本机只能注入'
  }),
  Object.freeze({
    provider: 'workbuddycn',
    label: 'WorkBuddy CN',
    channel: 'inject',
    adapter: 'tmux-inject',
    note: '服务端 teammate 不可从本机访问；经 aih 注入'
  }),
  Object.freeze({
    provider: 'codex',
    label: 'Codex',
    channel: 'inject',
    adapter: 'tmux-inject',
    note: 'collab agent 是进程内工具；跨进程没有 inbox，经 aih 注入'
  }),
  Object.freeze({
    provider: 'codexchat',
    label: 'Codex Chat',
    channel: 'inject',
    adapter: 'tmux-inject',
    note: 'collab agent 是进程内工具；跨进程没有 inbox，经 aih 注入'
  }),
  Object.freeze({
    provider: 'gemini',
    label: 'Gemini CLI',
    channel: 'inject',
    adapter: 'tmux-inject',
    note: '无跨会话通道，经 aih 注入'
  }),
  Object.freeze({
    provider: 'agy',
    label: 'Antigravity CLI',
    channel: 'inject',
    adapter: 'tmux-inject',
    note: '无跨会话通道，经 aih 注入'
  }),
  Object.freeze({
    provider: 'opencode',
    label: 'OpenCode',
    channel: 'inject',
    adapter: 'tmux-inject',
    note: '2.2.5 只有兼容层文案，没有本机 inbox；TUI 走注入'
  }),
  Object.freeze({
    provider: 'grok',
    label: 'Grok CLI',
    channel: 'inject',
    adapter: 'tmux-inject',
    note: '只有 subagent（会话树），没有跨会话通道'
  }),
  Object.freeze({
    provider: 'qoder',
    label: 'Qoder',
    channel: 'inject',
    adapter: 'tmux-inject',
    note: '单会话 TUI，经 aih 注入'
  }),
  Object.freeze({
    provider: 'qodercn',
    label: 'Qoder CN',
    channel: 'inject',
    adapter: 'tmux-inject',
    note: '单会话 TUI（国内站），经 aih 注入'
  }),
  Object.freeze({
    provider: 'cline',
    label: 'Cline',
    channel: 'inject',
    adapter: 'tmux-inject',
    note: '无跨会话通道，经 aih 注入'
  }),
  Object.freeze({
    provider: 'zcode',
    label: 'ZCode',
    channel: 'inject',
    adapter: 'tmux-inject',
    note: '无跨会话通道，经 aih 注入'
  }),
  Object.freeze({
    provider: 'kimi',
    label: 'Kimi CLI',
    channel: 'inject',
    adapter: 'tmux-inject',
    note: '无跨会话通道，经 aih 注入'
  }),
  Object.freeze({
    provider: 'kiro',
    label: 'Kiro',
    channel: 'inject',
    adapter: 'tmux-inject',
    note: '无跨会话通道，经 aih 注入'
  })
]);

const BY_PROVIDER = new Map(HARNESS_CHANNELS.map((entry) => [entry.provider, entry]));

// 通道能力表：**不是**按 provider 分（webui-chat 是 runtime，不是 harness），
// 而是按「投递机制」分。`delivery` 说明这条通道到底怎么把消息送到：
//   protocol  对端有协议端点，投递有 id / 挂起语义（claude UDS）
//   turn      对端有命令总线，投递是一次幂等命令（WebUI chat runtime）
//   inject    对端只能被代打字（tmux send-keys，等价用户手打）
// `receive` 目前三条通道都为 true：收件箱对所有通道一视同仁地落盘，
// 差别只在「送达」这一步的语义强弱。
const PEER_CHANNELS = Object.freeze([
  Object.freeze({
    channel: 'native',
    adapter: 'claude-uds',
    label: 'Claude UDS',
    delivery: 'protocol',
    receive: true,
    note: '本机 UDS：有 msg_id、收件方按 crossSessionInbound 策略投递或挂起'
  }),
  Object.freeze({
    channel: 'inject',
    adapter: 'tmux-inject',
    label: 'tmux 注入',
    delivery: 'inject',
    receive: true,
    note: '往 pane 敲一行信封 + Enter；先等安静期，等不到就排队'
  }),
  Object.freeze({
    channel: 'webui-chat',
    adapter: 'webui-chat',
    label: 'WebUI Chat',
    delivery: 'turn',
    receive: true,
    note: 'chat runtime 命令总线：空闲 turn.submit，忙则 queue.add'
  })
]);

const CHANNEL_BY_ID = new Map(PEER_CHANNELS.map((entry) => [entry.channel, entry]));

function getPeerChannel(channel) {
  return CHANNEL_BY_ID.get(String(channel || '').trim().toLowerCase()) || null;
}

function listPeerChannelRows() {
  return PEER_CHANNELS.slice();
}

function getHarnessChannel(provider) {
  return BY_PROVIDER.get(String(provider || '').trim().toLowerCase()) || null;
}

function listHarnessChannels() {
  return HARNESS_CHANNELS.slice();
}

/** 通道实现对象（native 才有；inject 由调用方传进来的 tmux 适配器承担）。 */
function getNativeAdapter(provider) {
  const entry = getHarnessChannel(provider);
  if (!entry || entry.channel !== 'native') return null;
  return entry.adapter === 'claude-uds' ? claudeUds : null;
}

module.exports = {
  HARNESS_CHANNELS,
  PEER_CHANNELS,
  getHarnessChannel,
  getNativeAdapter,
  getPeerChannel,
  listHarnessChannels,
  listPeerChannelRows
};
