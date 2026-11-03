#!/usr/bin/env node
'use strict';

/**
 * 采集各 provider CLI 的**当前用法基线**（版本 + 关键帮助片段），用于：
 *   1) 生成/刷新 docs/providers/agent-cli-usage.md（人读的完整用法文档）；
 *   2) 生成 docs/providers/agent-cli-usage.snapshot.json（机器可 diff 的快照）——
 *      升级 CLI 后重跑并与旧快照对比，新增的参数 / 子命令一眼可见。
 *
 * 用法：
 *   npm run providers:usage              # 打印 Markdown 到 stdout
 *   npm run providers:usage -- --write   # 写进 docs/providers/（md + json 快照）
 *   npm run providers:usage -- --json    # 只打印 JSON 快照
 *
 * 只读本机 CLI（`--version` / `--help`），不联网、不改任何配置。
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const { listProviderIds } = require('../lib/provider-catalog');
const { AI_CLI_CONFIGS } = require('../lib/cli/services/ai-cli/provider-registry');
const {
  buildProviderResumeVerbArgs,
  getDeclaredResumeFlags,
  resolveProviderResumeStrategy,
  RESUME_STRATEGYLESS_PROVIDERS
} = require('../lib/runtime/provider-resume');

const ROOT = path.join(__dirname, '..');
const DOC_PATH = path.join(ROOT, 'docs', 'providers', 'agent-cli-usage.md');
const SNAPSHOT_PATH = path.join(ROOT, 'docs', 'providers', 'agent-cli-usage.snapshot.json');
const HELP_LINE_LIMIT = 90;

/**
 * 采集用的环境：把**仓库自己的** `node_modules/.bin` 从 PATH 里剔除。
 *
 * 为什么：`npm run providers:usage` 会让 npm 把 `node_modules/.bin` 插到 PATH 最前面，
 * 于是 codex 这类「既是 provider CLI、又是本仓库依赖」的工具会被采成**仓库里那份**
 * （实测 0.142.3），而不是宿主真正在用的那份（实测 0.165.0）。这份基线描述的是
 * 「用户机器上的 CLI」，采错对象会让快照和 `aih <cli> version` 长期对不上。
 */
function buildCollectorEnv(baseEnv = process.env) {
  const delimiter = path.delimiter;
  const repoBinDir = path.resolve(path.join(ROOT, 'node_modules', '.bin'));
  const entries = String(baseEnv.PATH || '')
    .split(delimiter)
    .filter((entry) => entry && path.resolve(entry) !== repoBinDir);
  return {
    ...baseEnv,
    PATH: entries.join(delimiter),
    NO_COLOR: '1'
  };
}

const COLLECTOR_ENV = buildCollectorEnv(process.env);

// provider → 该 CLI 的二进制名（缺省用 provider id）。
const BINARY_OVERRIDES = Object.freeze({
  qoder: 'qodercli',
  qodercn: 'qoderclicn',
  kiro: 'kiro-cli'
});

// 需要额外抓的子命令帮助（aih 会替用户拼参数的那些路径）。
const EXTRA_HELP = Object.freeze({
  codex: [['resume', '--help'], ['exec', '--help']],
  opencode: [['run', '--help']],
  claude: [['--help']],
  gemini: [['--help']],
  cline: [['--help']]
});

function which(binary) {
  const result = spawnSync(process.platform === 'win32' ? 'where' : 'which', [binary], {
    encoding: 'utf8',
    windowsHide: true,
    env: COLLECTOR_ENV
  });
  if (result.status !== 0) return '';
  const first = String(result.stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0];
  return first || '';
}

function run(binary, args, timeoutMs = 8000) {
  try {
    const result = spawnSync(binary, args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      env: COLLECTOR_ENV
    });
    const text = `${result.stdout || ''}\n${result.stderr || ''}`.replace(/\x1b\[[0-9;]*m/g, '').trim();
    return { ok: result.status === 0, text };
  } catch (error) {
    return { ok: false, text: String((error && error.message) || error) };
  }
}

function pickHelpLines(text, pattern) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => pattern.test(line))
    .slice(0, HELP_LINE_LIMIT);
}

function collectProvider(provider) {
  const binary = BINARY_OVERRIDES[provider] || provider;
  const binaryPath = which(binary);
  const strategy = resolveProviderResumeStrategy(provider);
  const entry = {
    provider,
    binary,
    binaryPath,
    installed: Boolean(binaryPath),
    version: '',
    versionCommand: `${binary} --version`,
    unifiedResume: buildProviderResumeVerbArgs(provider, { sessionId: '<id>' }),
    unifiedResumeLatest: buildProviderResumeVerbArgs(provider, { sessionId: '' }),
    strategy: strategy ? strategy.id : '',
    resumeFlags: strategy ? [...strategy.declaredFlags] : [],
    contractFlags: getDeclaredResumeFlags(provider) || [],
    resumeInTuiOnly: RESUME_STRATEGYLESS_PROVIDERS.includes(provider),
    headless: (AI_CLI_CONFIGS[provider] && AI_CLI_CONFIGS[provider].headless) || null,
    helpExcerpts: []
  };
  if (!binaryPath) return entry;

  const version = run(binaryPath, ['--version']);
  entry.version = (version.text.split(/\r?\n/).filter(Boolean)[0] || '').trim();

  for (const args of (EXTRA_HELP[provider] || [['--help']])) {
    const help = run(binaryPath, args);
    entry.helpExcerpts.push({
      command: `${binary} ${args.join(' ')}`,
      lines: pickHelpLines(help.text, /resume|continue|session|--id|--last|version|Usage:/i)
    });
  }
  return entry;
}

function renderMarkdown(entries, generatedAt) {
  const installed = entries.filter((entry) => entry.installed);
  const lines = [];
  lines.push('# Agent CLI 用法基线（aih 托管）');
  lines.push('');
  lines.push(`> 生成命令：\`npm run providers:usage -- --write\`　生成时间：${generatedAt}`);
  lines.push('> 这是**当前各 CLI 版本**的用法快照。升级 CLI 后重跑本命令，并与本文档 /');
  lines.push('> `agent-cli-usage.snapshot.json` 做 diff：新增的参数、子命令、slash 提示一眼可见。');
  lines.push('> slash 命令多数只在 TUI 内出现，本机实测后补记到「slash 命令」小节。');
  lines.push('');
  lines.push('## 版本快照');
  lines.push('');
  lines.push('| provider | CLI | 版本 | aih 统一 resume | 原生 resume 形态 |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const entry of entries) {
    const unified = entry.unifiedResume.ok ? `\`aih ${entry.provider} resume <id>\`` : '—';
    const native = entry.strategy
      ? `\`${entry.strategy}\`：${entry.resumeFlags.join(' ')}`
      : (entry.resumeInTuiOnly
        ? `TUI 内：${(entry.contractFlags || []).map((flag) => `\`${flag}\``).join(' ') || 'slash 命令'}`
        : '未声明会话边界');
    const version = entry.installed ? (entry.version || '(未取到)') : '（未安装）';
    lines.push(`| ${entry.provider} | ${entry.binary} | ${version} | ${unified} | ${native} |`);
  }
  lines.push('');
  lines.push('## aih 统一入口（所有 provider 共用一套动词）');
  lines.push('');
  lines.push('- `aih <cli> resume [<id>]`：续接上一段对话；省略 `<id>` 时用该 CLI 的「最近一段」（没有安全退路的会明确报错）。');
  lines.push('- `aih <cli> fork [<id>]`：从上一段对话**分叉**出新会话（原对话不动）；无 fork 能力的 provider 明确拒绝。');
  lines.push('- `aih <cli> <账号> resume|fork [<id>]`：指定账号续接 / 分叉。');
  lines.push('- `aih <cli> resume --help`：打印统一动词与各 provider 原生形态对照表。');
  lines.push('- `aih <cli> sessions --history [--limit N]`：列出该 CLI 自己的会话（含 id），直接喂给 resume/fork；按账号隔离的 provider 会明确说明。');
  lines.push('- `aih <cli> version`：直接向原生 CLI 要版本号与二进制路径（不猜）。');
  lines.push('- `aih <cli> <任意原生参数>`：**完整透传**（`aih codex exec …`、`aih claude --model …` 都走原生），统一动词不影响它。');
  lines.push('- `aih <cli> -- <任意原生参数...>`：**逃生门** —— `--` 之后逐字交给原生 CLI，即使撞上 aih 自己的保留字（ls / login / sessions / resume …）也不拦截。');
  lines.push('- 事实来源：`contracts/providers/manifest.json` 的 `nativeBoundary.sessions.flags`；翻译表 `lib/runtime/provider-resume.js`。');
  lines.push('');
  lines.push('## 各 provider 明细');
  lines.push('');
  for (const entry of installed) {
    lines.push(`### ${entry.provider}（${entry.version || '版本未取到'}）`);
    lines.push('');
    lines.push(`- 二进制：\`${entry.binaryPath}\``);
    lines.push(`- 版本命令：\`${entry.versionCommand}\``);
    if ((entry.contractFlags || []).length) {
      lines.push(`- 合同声明的会话入口：${entry.contractFlags.map((flag) => `\`${flag}\``).join(' ')}`);
    }
    if (entry.unifiedResume.ok) {
      lines.push(`- 统一续接：\`aih ${entry.provider} resume <id>\` → 原生 \`${entry.unifiedResume.args.join(' ')}\``);
      lines.push(`- 统一续接（不带 id）：→ 原生 \`${entry.unifiedResumeLatest.ok ? entry.unifiedResumeLatest.args.join(' ') : '（报错：需要精确会话 id）'}\``);
    } else if (entry.resumeInTuiOnly) {
      lines.push(`- 统一 resume：不支持 —— 会话入口在 TUI 内（合同声明：${(entry.contractFlags || []).join(' ')}）。`);
    } else {
      lines.push('- 统一 resume：不支持 —— 合同未声明会话边界，aih 只透传原生命令。');
    }
    for (const excerpt of entry.helpExcerpts) {
      lines.push('');
      lines.push(`<details><summary><code>${excerpt.command}</code> 关键行</summary>`);
      lines.push('');
      lines.push('```');
      lines.push(...(excerpt.lines.length ? excerpt.lines : ['(未匹配到 resume/session/version 相关行)']));
      lines.push('```');
      lines.push('</details>');
    }
    lines.push('');
  }
  const missing = entries.filter((entry) => !entry.installed).map((entry) => entry.provider);
  if (missing.length) {
    lines.push('## 本机未安装（无法采集，装好后重跑本脚本即可补齐）');
    lines.push('');
    lines.push(`- ${missing.join('、')}`);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

function main() {
  const argv = process.argv.slice(2);
  const write = argv.includes('--write');
  const jsonOnly = argv.includes('--json');
  const generatedAt = new Date().toISOString();
  const entries = listProviderIds().map(collectProvider);
  const snapshot = { generatedAt, host: `${os.platform()}-${os.arch()}`, entries };
  const markdown = renderMarkdown(entries, generatedAt);

  if (jsonOnly) process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
  else process.stdout.write(markdown);

  if (write) {
    fs.mkdirSync(path.dirname(DOC_PATH), { recursive: true });
    fs.writeFileSync(DOC_PATH, markdown);
    fs.writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`);
    process.stderr.write(`[aih] wrote ${path.relative(ROOT, DOC_PATH)} and ${path.relative(ROOT, SNAPSHOT_PATH)}\n`);
  }
  return 0;
}

process.exit(main());

