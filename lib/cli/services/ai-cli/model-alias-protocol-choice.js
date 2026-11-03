'use strict';

// `--model-alias` 的**协议不对称**拦截（CLI 侧）。
//
// 场景：用户把厂商的 Anthropic 兼容地址（如 https://api.deepseek.com/anthropic）加进
// claude Provider，然后用 `aih codex --model-alias claude.deepseek-flash`。codex 说的是
// OpenAI 协议，请求会经「Responses → Anthropic Messages」适配层；DeepSeek 那层对工具
// 调用的转译不完整，模型会把原生 DSML 调用文本直接吐出来。
//
// 拦截点放在启动期（模型别名解析完成、真正拉起 CLI 之前），给两个明确的选择：
//   1) 自动适配协议 —— 本次会话按 OpenAI 格式请求同一厂商的 OpenAI 端点（不新增账号）；
//   2) 新增到 codex  —— 把该 claude 账号复制成 codex API Key 账号（可复用）。
//
// 「哪些账号可适配/可复制」全部来自 lib/account/upstream-protocol-variants.js 的能力表，
// 这里不判断厂商名。目标 CLI 是否支持提示也是一张表（HINT_CLIENTS）：只有 codex 有
// 现成的 `-c http_headers` 通道与 AIH_CODEX_FLAGS 上下文。

const { spawnSync: defaultSpawnSync } = require('node:child_process');
const { listAccountCredentialRecords, writeAccountCredentials } = require('../../../server/account-credential-store');
const { isAccountRef, resolveAccountRefByCliId, resolveCliAccountRef } = require('../../../server/account-ref-store');
const { registerAccountIdentity } = require('../../../account/account-registration');
const { buildApiKeyIdentity } = require('../../../account/transfer-core');
const { buildManagementBaseUrl } = require('../../../server/server-defaults');
const { getUpstreamProtocolVariant } = require('../../../account/upstream-protocol-variants');

// 支持「协议提示」的 CLI（数据表）。目前只有 codex：它既有自定义头通道，也有现成的
// AIH_CODEX_FLAGS 上下文；原生 CLI 的 base URL 通道没有承载这个字段的位置
// （AGENTS.md 禁止为一个会话选项新增 AIH_* 变量）。
const HINT_CLIENTS = Object.freeze({ codex: true });

const CHOICE_ADAPT = 'adapt';
const CHOICE_COPY = 'copy';
const CHOICE_KEEP = 'keep';
const PROTOCOL = 'openai_chat';

function text(value) {
  return String(value == null ? '' : value).trim();
}

function resolvePinnedAccountRef(input = {}) {
  const account = text(input.account);
  const provider = text(input.provider);
  if (!account || !provider) return '';
  if (isAccountRef(account)) return account;
  const record = resolveAccountRefByCliId(input.fs, input.aiHomeDir, provider, account, { bestEffort: true });
  return record && record.accountRef ? record.accountRef : '';
}

/**
 * 找出本次别名目标里「可切换协议」的账号。
 *
 * 返回 null 表示不适用（目标没有 provider、能力表没有该 provider 的另一种协议、
 * 没有可用 API Key 账号、或显式钉选的账号不存在）。调用方据此完全跳过提示。
 */
function listProtocolChoiceCandidates(input = {}) {
  const rule = input.rule && typeof input.rule === 'object' ? input.rule : null;
  const provider = text(rule && rule.provider);
  if (!provider) return null;
  const variant = getUpstreamProtocolVariant(provider, PROTOCOL);
  if (!variant || typeof variant.readCopySource !== 'function') return null;
  const pinnedAccountRef = resolvePinnedAccountRef({
    fs: input.fs,
    aiHomeDir: input.aiHomeDir,
    provider,
    account: rule.account
  });
  // 显式钉了账号但解析不到：不做任何猜测，按现状启动。
  if (text(rule.account) && !pinnedAccountRef) return null;
  const records = listAccountCredentialRecords(input.fs, input.aiHomeDir, provider);
  const candidates = [];
  for (const record of records) {
    if (pinnedAccountRef && record.accountRef !== pinnedAccountRef) continue;
    const source = variant.readCopySource(record.env);
    if (!source) continue;
    const cli = resolveCliAccountRef(input.fs, input.aiHomeDir, record.accountRef, { bestEffort: true });
    candidates.push({
      accountRef: record.accountRef,
      cliAccountId: text(cli && cli.cliAccountId),
      provider,
      baseUrl: source.baseUrl,
      openAIBaseUrl: source.openAIBaseUrl,
      source
    });
  }
  if (candidates.length < 1) return null;
  return {
    provider,
    protocol: PROTOCOL,
    model: text(rule.target),
    variant,
    candidates
  };
}

function canPromptInteractively(processImpl, readLine) {
  const stdin = processImpl && processImpl.stdin;
  return Boolean(stdin && stdin.isTTY && readLine && typeof readLine.question === 'function');
}

function formatCandidateLine(candidate) {
  const id = candidate.cliAccountId ? '#' + candidate.cliAccountId : candidate.accountRef.slice(0, 12);
  return '  - ' + candidate.provider + ' ' + id + ': ' + candidate.baseUrl + ' → ' + candidate.openAIBaseUrl;
}

function printChoicePrompt(input = {}) {
  const info = input.info;
  const lines = [
    '\x1b[33m[aih]\x1b[0m 协议不匹配：--model-alias 让 ' + input.cliName + ' 使用 '
      + info.provider + ' 的 ' + (input.model || info.model) + '，',
    '      但该账号的上游是 Anthropic 兼容端点，而 ' + input.cliName + ' 发送的是 OpenAI 协议。',
    '      继续转发会经过 Anthropic 适配层，工具调用可能被模型以 DSML 文本输出。',
    ...info.candidates.map(formatCandidateLine),
    '',
    '  1) 自动适配协议：本次会话改用同一厂商的 OpenAI 端点（不新增账号）',
    '  2) 新增到 codex：把上述账号复制为 codex API Key 账号（后续可复用）',
    '  3) 保持现状：仍按 Anthropic 端点转发',
    ''
  ];
  input.stderr.write(lines.join('\n') + '\n');
}

function parseChoiceAnswer(value) {
  const answer = text(value).toLowerCase();
  if (answer === '1' || answer === 'adapt') return CHOICE_ADAPT;
  if (answer === '2' || answer === 'copy') return CHOICE_COPY;
  return CHOICE_KEEP;
}

function promptProtocolChoice(input = {}) {
  const readLine = input.readLine;
  const stderr = input.stderr;
  printChoicePrompt({ ...input, stderr });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const answer = text(readLine.question('请选择 [1/2/3]（默认 3）: '));
    if (!answer) return CHOICE_KEEP;
    if (/^(1|2|3|adapt|copy|keep)$/i.test(answer)) return parseChoiceAnswer(answer);
    stderr.write('请输入 1、2 或 3。\n');
  }
  return CHOICE_KEEP;
}

function copyCandidatesToTarget(input = {}) {
  const info = input.info;
  const variant = info && info.variant;
  const target = variant && variant.copyTarget;
  if (!target || typeof target.buildEnv !== 'function') {
    return { created: [], error: 'protocol_copy_target_unavailable' };
  }
  const created = [];
  for (const candidate of info.candidates) {
    const env = target.buildEnv(candidate.source);
    const identitySeed = buildApiKeyIdentity(target.provider, { config: env });
    if (!identitySeed) continue;
    const registration = registerAccountIdentity(input.fs, input.aiHomeDir, {
      provider: target.provider,
      identitySeed
    });
    writeAccountCredentials(input.fs, input.aiHomeDir, registration.accountRef, env);
    created.push({
      accountRef: registration.accountRef,
      cliAccountId: text(registration.cliAccountId),
      created: registration.created === true,
      sourceCliAccountId: candidate.cliAccountId,
      openAIBaseUrl: candidate.openAIBaseUrl
    });
  }
  return { created, error: created.length > 0 ? '' : 'protocol_copy_failed' };
}

// 运行中的 server 不会自动感知 CLI 写入的新账号（生命周期总线只在本进程内），
// 因此复制完必须让它重载一次账号池。用子进程做同步 HTTP：CLI 的启动链路是同步的，
// 而首条请求马上就会发生，异步 fire-and-forget 会输掉这个竞态。
// 密钥走 stdin，不进 argv / 环境变量。
function reloadServerAccountsSync(input = {}) {
  const fs = input.fs;
  const aiHomeDir = input.aiHomeDir;
  const readServerConfig = input.readServerConfig;
  if (!fs || !aiHomeDir || typeof readServerConfig !== 'function') return false;
  let config = null;
  try {
    config = readServerConfig({ fs, aiHomeDir }) || {};
  } catch (_error) {
    return false;
  }
  const url = buildManagementBaseUrl(config) + '/reload';
  const payload = JSON.stringify({ url, key: text(config.managementKey) });
  const script = [
    "const fs=require('node:fs');",
    "let p={};try{p=JSON.parse(fs.readFileSync(0,'utf8')||'{}')}catch(_){process.exit(2)}",
    "const h={};if(p.key)h.authorization='Bearer '+p.key;",
    "fetch(p.url,{method:'POST',headers:h,signal:AbortSignal.timeout(2000)})",
    '.then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1));'
  ].join('\n');
  const spawnSyncImpl = typeof input.spawnSync === 'function' ? input.spawnSync : defaultSpawnSync;
  try {
    const result = spawnSyncImpl(process.execPath, ['-e', script], {
      input: payload,
      timeout: 4000,
      stdio: ['pipe', 'ignore', 'ignore'],
      windowsHide: true
    });
    return Number(result && result.status) === 0;
  } catch (_error) {
    return false;
  }
}

/**
 * 入口：返回本次会话真正要用的规则（可能被改成目标 provider）。
 *
 * 任何异常都按「保持现状」处理：这是启动链路上的提示，不能因为读库/复制失败把
 * 用户原本能用的命令拦死。
 */
function maybeOfferModelAliasProtocolChoice(input = {}) {
  const rule = input.rule;
  if (!rule || typeof rule !== 'object') return { rule, upstreamProtocol: '' };
  const cliName = text(input.cliName).toLowerCase();
  if (!HINT_CLIENTS[cliName]) return { rule, upstreamProtocol: '' };
  let info = null;
  try {
    info = listProtocolChoiceCandidates({
      fs: input.fs,
      aiHomeDir: input.aiHomeDir,
      rule
    });
  } catch (_error) {
    return { rule, upstreamProtocol: '' };
  }
  if (!info) return { rule, upstreamProtocol: '' };
  const stderr = input.stderr || (input.processImpl && input.processImpl.stderr) || process.stderr;
  if (!canPromptInteractively(input.processImpl, input.readLine)) {
    const targetProvider = info.variant.copyTarget ? info.variant.copyTarget.provider + '.' : '';
    stderr.write(
      '\x1b[33m[aih]\x1b[0m --model-alias 指向 ' + info.provider + ' 的 Anthropic 兼容端点，'
      + '当前 ' + cliName + ' 使用 OpenAI 协议；非交互环境不做改动。'
      + '可用 --model-alias ' + targetProvider + info.model + ' 或交互式运行以选择协议适配。\n'
    );
    return { rule, upstreamProtocol: '' };
  }
  const choice = promptProtocolChoice({ info, cliName, readLine: input.readLine, stderr });
  if (choice === CHOICE_ADAPT) {
    stderr.write(
      '\x1b[33m[aih]\x1b[0m 已启用协议适配：本次会话按 OpenAI 格式请求 '
      + info.candidates.map((candidate) => candidate.openAIBaseUrl).filter(Boolean).join(' / ') + '\n'
    );
    // 不写 env：AIH_CODEX_FLAGS 会被 filterHostEnvVars 当作「宿主残留」删掉，
    // 提示必须走启动链路的 runtimeOptions 到 buildProviderRuntimeEnv 再注入。
    return { rule, upstreamProtocol: info.protocol };
  }
  if (choice === CHOICE_COPY) {
    let result = { created: [], error: 'protocol_copy_failed' };
    try {
      result = copyCandidatesToTarget({ fs: input.fs, aiHomeDir: input.aiHomeDir, info });
    } catch (error) {
      result = { created: [], error: (error && (error.message || error.code)) || 'protocol_copy_failed' };
    }
    if (!result.created.length) {
      const targetLabel = info.variant.copyTarget ? info.variant.copyTarget.provider : '目标 Provider';
      stderr.write(
        '\x1b[31m[aih]\x1b[0m 复制到 ' + targetLabel + ' 失败：'
        + (result.error || 'unknown_error') + '；本次继续按原规则启动。\n'
      );
      return { rule, upstreamProtocol: '' };
    }
    const reloaded = reloadServerAccountsSync({
      fs: input.fs,
      aiHomeDir: input.aiHomeDir,
      readServerConfig: input.readServerConfig,
      spawnSync: input.spawnSync
    });
    const copied = result.created
      .map((item) => '#' + (item.cliAccountId || item.accountRef.slice(0, 12)))
      .join(', ');
    stderr.write(
      '\x1b[33m[aih]\x1b[0m 已复制到 ' + info.variant.copyTarget.provider + '：' + copied + '\n'
    );
    if (!reloaded) {
      stderr.write(
        '\x1b[33m[aih]\x1b[0m 未能通知运行中的 aih server 重载账号池；'
        + '若本次请求立即报「没有可用账号」，执行 aih server restart 后重试。\n'
      );
    }
    // 目标 provider 换了，账号位必须清掉：claude 的编号在 codex 里指另一个账号。
    return {
      rule: { ...rule, provider: info.variant.copyTarget.provider, account: '' },
      upstreamProtocol: ''
    };
  }
  return { rule, upstreamProtocol: '' };
}

module.exports = {
  CHOICE_ADAPT,
  CHOICE_COPY,
  CHOICE_KEEP,
  HINT_CLIENTS,
  canPromptInteractively,
  copyCandidatesToTarget,
  formatCandidateLine,
  listProtocolChoiceCandidates,
  maybeOfferModelAliasProtocolChoice,
  parseChoiceAnswer,
  reloadServerAccountsSync
};
