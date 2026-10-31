'use strict';

/**
 * `aih harness` —— 用**某个 Provider 的某个账号**跑外部 harness（pi / dsh / dsh-tui）。
 *
 * 为什么需要它：外部 harness 不是 AIH 的 Provider（没有自己的账号池），它通过本地 AIH
 * 网关拿模型。没有这个命令时，用户只能从 WebUI 选"harness + 身份账号"，CLI 侧只能靠
 * 环境变量碰运气。这里把选择收成一句命令：
 *
 *   aih harness                     列出可用的 harness
 *   aih harness pi                  用默认账号跑 pi
 *   aih harness pi --provider codex --account 2       用 codex 的 2 号账号跑 pi
 *   aih harness dsh --provider codebuddycn --account acct_0123… -- --native-args
 *   aih harness pi --provider codex --account 2 --json  只打印解析结果，不启动
 *
 * 语义是 **relay**：harness 自己的进程里没有任何原生 Provider 凭据（run.js 会把
 * ANTHROPIC_API_KEY 之类整键剥掉），所有请求都带着"钉住 provider+account"的网关身份，
 * 由 aih 服务端按该账号路由与计费。
 */

const nodePath = require('node:path');
const { listExternalHarnesses, getExternalHarness } = require('../../../harness/catalog');
const { resolveAiHomeDir } = require('../../../runtime/aih-home');
const { resolveHostHomeDir } = require('../../../runtime/host-home');
const {
  listCliAccountRefRecords,
  resolveAccountRefByCliId,
  resolveCliAccountRef
} = require('../../../server/account-ref-store');

const HELP = [
  'aih harness — 用某个 Provider 的某个账号跑外部 harness（请求经本地网关转发）',
  '',
  '用法：',
  '  aih harness                                   列出可用的 harness',
  '  aih harness <id> [选项] [-- 原生参数...]        启动',
  '',
  '选项：',
  '  --provider <p>    身份 Provider（codex / claude / codebuddycn …）',
  '  --account <n|ref> 账号：CLI 账号 id（1、2…）或 accountRef（acct_…）',
  '  --model <m>       模型别名或原名（默认取该账号的默认模型）',
  '  --json            只打印解析结果（harness / provider / accountRef / model）',
  '  --list            同 aih harness',
  '  -h, --help        本帮助',
  '',
  '例：',
  '  aih harness pi --provider codex --account 2',
  '  aih harness dsh-tui --provider codebuddycn --account 1 --model sonnet',
  ''
].join('\n');

function takeValue(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0) return { rest: argv, value: '' };
  const value = argv[index + 1] === undefined ? '' : String(argv[index + 1]);
  return { rest: [...argv.slice(0, index), ...argv.slice(index + 2)], value };
}

function takeInlineValue(argv, name) {
  const inline = argv.find((token) => String(token).startsWith(`${name}=`));
  if (!inline) return { rest: argv, value: '' };
  return {
    rest: argv.filter((token) => token !== inline),
    value: String(inline).slice(name.length + 1)
  };
}

function takeFlag(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0) return { rest: argv, present: false };
  return { rest: [...argv.slice(0, index), ...argv.slice(index + 1)], present: true };
}

/**
 * 解析 `aih harness …` 的参数。纯函数（不读盘），便于补全与测试复用。
 *
 * @returns {{ harnessId: string, provider: string, account: string, model: string,
 *            json: boolean, list: boolean, help: boolean, nativeArgs: string[] }}
 */
function parseHarnessArgs(argv = []) {
  let rest = (Array.isArray(argv) ? argv : []).map(String);
  const result = { harnessId: '', provider: '', account: '', model: '', json: false, list: false, help: false, nativeArgs: [] };

  const separator = rest.indexOf('--');
  if (separator >= 0) {
    result.nativeArgs = rest.slice(separator + 1);
    rest = rest.slice(0, separator);
  }

  if (rest.includes('-h') || rest.includes('--help') || rest[0] === 'help') result.help = true;
  const listFlag = takeFlag(rest, '--list');
  rest = listFlag.rest;
  if (listFlag.present) result.list = true;
  const jsonFlag = takeFlag(rest, '--json');
  rest = jsonFlag.rest;
  result.json = jsonFlag.present;

  for (const name of ['--provider', '--account', '--model']) {
    const spaced = takeValue(rest, name);
    rest = spaced.rest;
    const inline = takeInlineValue(rest, name);
    rest = inline.rest;
    const value = spaced.value || inline.value;
    if (name === '--provider') result.provider = value.toLowerCase();
    if (name === '--account') result.account = value;
    if (name === '--model') result.model = value;
  }

  result.harnessId = String(rest[0] || '').trim().toLowerCase();
  return result;
}

function formatHarnessList(harnesses) {
  const lines = ['外部 harness（通过本地 AIH 网关使用 Provider 账号）：', ''];
  for (const harness of harnesses) {
    lines.push(`  ${harness.id.padEnd(10)} ${harness.label || ''}${harness.description ? ` — ${harness.description}` : ''}`);
  }
  lines.push('');
  lines.push('用法：aih harness <id> --provider <p> [--account <n|ref>] [--model <m>]');
  return lines.join('\n');
}

/**
 * 选账号：显式 id / accountRef，或该 Provider 的默认账号（优先 CLI 账号 id 1）。
 */
function selectAccount(options = {}) {
  const fs = options.fs;
  const aiHomeDir = String(options.aiHomeDir || '').trim();
  const provider = String(options.provider || '').trim().toLowerCase();
  const account = String(options.account || '').trim();
  if (!provider || !aiHomeDir) return { ok: false, error: 'provider_and_home_required' };

  if (account && /^acct_[a-f0-9]{20}$/.test(account)) {
    const record = resolveCliAccountRef(fs, aiHomeDir, account, { bestEffort: true });
    if (!record) return { ok: false, error: 'account_ref_not_found' };
    return { ok: true, accountRef: record.accountRef, cliAccountId: record.cliAccountId === undefined ? '' : String(record.cliAccountId) };
  }

  if (account && /^\d+$/.test(account)) {
    const record = resolveAccountRefByCliId(fs, aiHomeDir, provider, account, { bestEffort: true });
    if (!record) return { ok: false, error: 'account_not_found' };
    return { ok: true, accountRef: record.accountRef, cliAccountId: String(record.cliAccountId || account) };
  }

  if (account) return { ok: false, error: 'account_not_found' };

  const records = listCliAccountRefRecords(fs, aiHomeDir, provider, { bestEffort: true }) || [];
  if (!records.length) return { ok: false, error: 'account_not_found' };
  const preferred = records.find((record) => String(record.cliAccountId) === '1') || records[0];
  return { ok: true, accountRef: preferred.accountRef, cliAccountId: String(preferred.cliAccountId || '') };
}

/**
 * @param {string[]} argv  `harness` 之后的参数
 * @param {object} context 注入依赖（fs / aiHomeDir / hostHomeDir / runExternalHarness / stdout）
 * @returns {Promise<number>} 退出码
 */
async function runHarnessCommand(argv = [], context = {}) {
  const fs = context.fs || require('node:fs');
  const stdout = context.stdout || process.stdout;
  const stderr = context.stderr || process.stderr;
  const env = context.env || process.env;
  const harnesses = listExternalHarnesses();

  const parsed = parseHarnessArgs(argv);
  if (parsed.help) {
    stdout.write(HELP);
    return 0;
  }
  if (parsed.list || !parsed.harnessId) {
    stdout.write(`${formatHarnessList(harnesses)}\n`);
    return 0;
  }

  const harness = getExternalHarness(parsed.harnessId);
  if (!harness) {
    stderr.write(`[aih] 未知 harness：${parsed.harnessId}\n${formatHarnessList(harnesses)}\n`);
    return 1;
  }
  if (!parsed.provider) {
    stderr.write('[aih] 需要 --provider <p>（这个 harness 要用哪个 Provider 的账号跑）\n');
    return 1;
  }

  const aiHomeDir = String(context.aiHomeDir || '').trim() || resolveAiHomeDir({ env });
  const hostHomeDir = String(context.hostHomeDir || '').trim() || resolveHostHomeDir({ env });
  const selection = selectAccount({ fs, aiHomeDir, provider: parsed.provider, account: parsed.account });
  if (!selection.ok) {
    const hint = selection.error === 'account_not_found'
      ? `（${parsed.provider} 下没有可用账号；先 aih ${parsed.provider} login）`
      : '';
    stderr.write(`[aih] 选账号失败：${selection.error}${hint}\n`);
    return 1;
  }

  const plan = {
    ok: true,
    harness: harness.id,
    label: harness.label || '',
    provider: parsed.provider,
    accountRef: selection.accountRef,
    cliAccountId: selection.cliAccountId,
    model: parsed.model,
    nativeArgs: parsed.nativeArgs
  };
  if (parsed.json) {
    stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return 0;
  }

  const runner = context.runExternalHarness
    || ((input) => require('../../../harness/run').runExternalHarness(input));

  stdout.write(`\x1b[36m[aih]\x1b[0m harness ${harness.id} ← ${parsed.provider}${selection.cliAccountId ? ` #${selection.cliAccountId}` : ''} (${selection.accountRef.slice(0, 11)}…)\n`);
  const result = await runner({
    harness: harness.id,
    provider: parsed.provider,
    accountRef: selection.accountRef,
    model: parsed.model,
    nativeArgs: parsed.nativeArgs,
    aiHomeDir,
    hostHomeDir,
    env,
    cwd: context.cwd || process.cwd(),
    fs,
    path: nodePath
  });
  if (!result || result.ok === false) {
    stderr.write(`[aih] harness 启动失败：${(result && (result.message || result.error)) || 'unknown_error'}\n`);
    return 1;
  }
  return Number.isInteger(result.code) ? result.code : 0;
}

module.exports = {
  HELP,
  formatHarnessList,
  parseHarnessArgs,
  runHarnessCommand,
  selectAccount
};
