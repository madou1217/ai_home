'use strict';

// 内置标题来源 —— 普适事实，不是某家 provider 的特性。
//
// 每个来源只做一件事：把手里的事实变成帧。**不判断显示开关**（门面管），
// **不读终端**（transport 管），**不做 I/O 密集的解析**（标题每次状态变化都重算）。
//
// 帧的顺序 = 轮播顺序 = priority 升序。当前的设计口径：
//   1. session  会话自己的名字（codex thread title / 用户命名的会话）
//   2. identity provider:账号序号:模型   ← 「这是哪个会话」
//   3. route    网关模式：当前路由到的账号 / 模型（本地账号模式为空）
//   4. usage    剩余额度、重置时间、窗口（5h / 7days）
//   5. account  邮箱 / 套餐   ← 「这是谁的账号」
//
// 「会话名」与「身份」分开是因为它们的来源不同（会话名来自 provider 会话库，
// 身份来自账号路由），且会话名经常缺席（裸启动的会话没有名字）——合成一帧会让
// 「没有会话名」连带吃掉身份。

const { resolveProviderShortLabel } = require('../labels');

const PRIORITY = Object.freeze({
  session: 10,
  identity: 20,
  route: 30,
  usage: 40,
  account: 50,
  question: 60,
  retry: 70,
  stateError: 80,
  statusline: 90
});

function readText(value) {
  return String(value == null ? '' : value).trim();
}

// ── 1. 会话名 ────────────────────────────────────────────────────────────────
// 只在**有真名字**时出帧：provider 侧的可读标题（codex thread title 之类），
// 或者用户显式命名的会话（`s-<label>`）。刻意不用「推导出来的项目目录名」——
// 同一项目的多个会话挂着同一个目录名，既占宽又区分不了谁是谁。
function createSessionTitleSource() {
  return {
    id: 'session',
    capability: 'title.session',
    priority: PRIORITY.session,
    provide(ctx = {}) {
      const label = readText(ctx.sessionLabel);
      return label ? [label] : [];
    }
  };
}

// ── 2. 身份 ─────────────────────────────────────────────────────────────────
// `provider:账号序号:模型`，与用户看到的账号列表口径一致。模型未知时退化成
// `provider:账号序号`——宁缺一段，也不要写一个假模型名。
//
// 账号序号缺席时**不返回空**：退化成 `provider:模型` 或只留 provider。这是
// 「直接用 aih provider」的场景（网关模式没有钉选账号），此时会话名与身份仍然
// 应该照常显示，而不是整条标题消失。
function createIdentityTitleSource() {
  return {
    id: 'identity',
    capability: 'title.identity',
    priority: PRIORITY.identity,
    provide(ctx = {}) {
      const provider = resolveProviderShortLabel(ctx.provider);
      const accountId = readText(ctx.accountId);
      const model = readText(ctx.model);
      const head = accountId ? [provider, accountId].filter(Boolean).join(':') : provider;
      const body = [head, model].filter(Boolean).join(':');
      return body ? [body] : [];
    }
  };
}

// ── 3. 网关路由 ──────────────────────────────────────────────────────────────
// 网关模式（`aih claude` / `aih codex` 不带账号）下，请求由本地 server 按池调度，
// 每个回合可能落到不同账号。这一帧回答「当前路由到了哪个账号、哪个模型」。
//
// 本地钉选账号模式下 ctx.route 为空 → 不出帧（身份帧已经写清账号了，重复是噪音）。
function createRouteTitleSource() {
  return {
    id: 'route',
    capability: 'title.route',
    priority: PRIORITY.route,
    provide(ctx = {}) {
      const route = ctx.route;
      if (!route || typeof route !== 'object') return [];
      const accountId = readText(route.accountId);
      const model = readText(route.model);
      if (!accountId && !model) return [];
      const head = accountId ? `→${accountId}` : '';
      return [[head, model].filter(Boolean).join(':')].filter(Boolean);
    }
  };
}

// ── 4. 额度 ─────────────────────────────────────────────────────────────────
// ctx.usageFrames 由用量侧归一后传入（窗口标签 + 剩余百分比 + 重置时间），
// 这里只负责透传——额度的取数口径属于 `lib/usage/quota`，不属于标题层。
//
// 传字符串数组或 `{label, remainingPct, resetIn}` 数组都接受：前者已经是成品帧，
// 后者按「标签:百分比 重置时间」渲染。没有额度面时返回空数组（不是失败）。
function formatUsageFrame(entry) {
  if (typeof entry === 'string') return readText(entry);
  if (!entry || typeof entry !== 'object') return '';
  const label = readText(entry.label || entry.window || entry.bucket);
  const pct = entry.remainingPct;
  const hasPct = pct != null && pct !== '' && Number.isFinite(Number(pct));
  const pctText = hasPct ? `${Math.round(Math.max(0, Math.min(100, Number(pct))))}%` : '';
  const head = [label, pctText].filter(Boolean).join(':');
  const reset = readText(entry.resetIn);
  return [head, reset ? `重置 ${reset}` : ''].filter(Boolean).join(' ');
}

function createUsageTitleSource() {
  return {
    id: 'usage',
    capability: 'title.usage',
    priority: PRIORITY.usage,
    provide(ctx = {}) {
      const input = ctx.usageFrames;
      if (!Array.isArray(input)) return [];
      return input.map(formatUsageFrame).filter(Boolean);
    }
  };
}

// ── 5. 账号 ─────────────────────────────────────────────────────────────────
// 邮箱 / 套餐：快照里的 `account.email` / `account.planType` 是权威事实
// （见 lib/account/usage-remaining.js 的快照形状）。
//
// 邮箱默认**不**进标题：`aih ls` 的账号序号已经能对上人，标签栏里塞邮箱是长文本。
// 用户显式要（`ctx.showAccountIdentity`）时才出帧——这是「参照 harness statusline」
// 的那部分自由配置。
function createAccountTitleSource() {
  return {
    id: 'account',
    capability: 'title.account',
    priority: PRIORITY.account,
    provide(ctx = {}) {
      if (!ctx.showAccountIdentity) return [];
      const account = ctx.account;
      if (!account || typeof account !== 'object') return [];
      const email = readText(account.email);
      const plan = readText(account.planType || account.planName);
      if (!email && !plan) return [];
      return [[email, plan].filter(Boolean).join(' ')];
    }
  };
}

function readSessionState(ctx = {}) {
  return ctx.sessionState && typeof ctx.sessionState === 'object' ? ctx.sessionState : {};
}

function createQuestionTitleSource() {
  return {
    id: 'question',
    capability: 'title.interaction',
    priority: PRIORITY.question,
    provide(ctx = {}) {
      const question = readText(readSessionState(ctx).question && readSessionState(ctx).question.question);
      return question ? [`? ${question}`] : [];
    }
  };
}

function createRetryTitleSource() {
  return {
    id: 'retry',
    capability: 'title.retry',
    priority: PRIORITY.retry,
    provide(ctx = {}) {
      const retry = readSessionState(ctx).retry;
      if (!retry || !Number.isFinite(Number(retry.attempt))) return [];
      const attempt = Math.max(1, Math.floor(Number(retry.attempt)));
      const max = Number.isFinite(Number(retry.maxAttempts)) ? Math.max(attempt, Math.floor(Number(retry.maxAttempts))) : 0;
      return [`↻ retry ${attempt}${max ? `/${max}` : ''}`];
    }
  };
}

function createStateErrorTitleSource() {
  return {
    id: 'state-error',
    capability: 'title.error',
    priority: PRIORITY.stateError,
    provide(ctx = {}) {
      const state = readSessionState(ctx);
      if (state.turnState === 'interrupted') return ['⚠ interrupted'];
      if (state.turnState !== 'failed' || !state.error) return [];
      const message = readText(state.error.message);
      return [message ? `⚠ ${message}` : '⚠ error'];
    }
  };
}

function createStatuslineTitleSource() {
  return {
    id: 'statusline',
    capability: 'title.statusline',
    priority: PRIORITY.statusline,
    provide(ctx = {}) {
      const statusline = readSessionState(ctx).statusline;
      if (!statusline || typeof statusline !== 'object') return [];
      const fields = [];
      if (Number.isFinite(Number(statusline.contextPct))) fields.push(`context ${Math.round(Number(statusline.contextPct))}%`);
      if (Number.isFinite(Number(statusline.tokens))) fields.push(`${Math.round(Number(statusline.tokens))} tokens`);
      return fields.length ? [fields.join(' · ')] : [];
    }
  };
}

function createBuiltinTitleSources() {
  return [
    createSessionTitleSource(),
    createIdentityTitleSource(),
    createRouteTitleSource(),
    createUsageTitleSource(),
    createAccountTitleSource(),
    createQuestionTitleSource(),
    createRetryTitleSource(),
    createStateErrorTitleSource(),
    createStatuslineTitleSource()
  ];
}

module.exports = {
  PRIORITY,
  createBuiltinTitleSources,
  createSessionTitleSource,
  createIdentityTitleSource,
  createRouteTitleSource,
  createUsageTitleSource,
  createAccountTitleSource,
  createQuestionTitleSource,
  createRetryTitleSource,
  createStateErrorTitleSource,
  createStatuslineTitleSource,
  formatUsageFrame
};
