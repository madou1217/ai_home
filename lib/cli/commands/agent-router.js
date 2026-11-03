'use strict';

// `aih agent` 的路由：只做参数解析与展示。
// 能力表、候选降级链、adapter 是否已实现，全部来自 lib/agent-session/registry + facade，
// 这里不写任何 provider 名。

const {
  describeAllProviders,
  describeProvider,
  resolveAdapter,
  isAdapterImplemented
} = require('../../agent-session/facade');
const { listExcludedHarnesses, listAdapterCapabilityRows } = require('../../agent-session/registry');
const { INTERACTION_KINDS } = require('../../agent-session/contracts');

const USAGE = [
  'aih agent [adapters] [--json]              # 每个 TUI harness 用哪个 adapter',
  'aih agent capabilities <provider> [--json] # 三种交互各自的支持级别与证据',
  'aih agent probe <provider> [--json]        # 现在实际会选中哪个 adapter'
].join('\n  ');

const KIND_LABELS = Object.freeze({
  approval: '审批',
  question: '提问',
  plan_confirmation: '计划确认'
});

const LEVEL_LABELS = Object.freeze({
  native: 'native',
  emulated: 'emulated',
  unsupported: 'unsupported'
});

const PROVIDER_COLUMNS = Object.freeze([14, 7, 20, 8]);
const PROVIDER_HEADER = ['PROVIDER', 'PHASE', 'ADAPTER', 'STATE']
  .map((label, index) => label.padEnd(PROVIDER_COLUMNS[index]))
  .join('  ');
const CAPABILITY_COLUMNS = Object.freeze([18, 13]);
const CAPABILITY_HEADER = ['KIND', 'LEVEL']
  .map((label, index) => label.padEnd(CAPABILITY_COLUMNS[index]))
  .join('  ');

function printHelp(write) {
  write([
    '\x1b[36maih agent\x1b[0m - 每个 TUI harness 的会话适配层',
    '',
    '\x1b[90m用法:\x1b[0m',
    `  ${USAGE}`,
    '',
    '\x1b[90m级别:\x1b[0m',
    '  native       harness 自己有结构化协议（可靠，带 id）',
    '  emulated     aih 从别处翻译出来（工具调用截获 / 屏幕探测）',
    '  unsupported  这条交互拿不到；aih 会明确报错，不会自动放行',
    '',
    '\x1b[90m例子:\x1b[0m',
    '  aih agent                          # 看全量登记表',
    '  aih agent capabilities codex       # codex 三种交互从哪来',
    '  aih agent probe claude             # 现在会选中哪个 adapter',
    ''
  ].join('\n'));
}

function parseArgs(argv) {
  const options = { action: '', provider: '', json: false, help: false };
  const list = argv.map((item) => String(item));
  for (let index = 0; index < list.length; index += 1) {
    const token = list[index];
    if (token === '--json') {
      options.json = true;
      continue;
    }
    if (token === '--help' || token === '-h' || token === 'help') {
      options.help = true;
      continue;
    }
    if (token.startsWith('-')) continue;
    if (!options.action) options.action = token;
    else if (!options.provider) options.provider = token;
  }
  return options;
}

// 中文按两列宽计算，否则能力表会错位（padEnd 只数字符数）。
function displayWidth(text) {
  let width = 0;
  for (const char of String(text)) {
    const code = char.codePointAt(0);
    const wide = (code >= 0x1100 && code <= 0x115f)
      || (code >= 0x2e80 && code <= 0xa4cf)
      || (code >= 0xac00 && code <= 0xd7a3)
      || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xfe30 && code <= 0xfe6f)
      || (code >= 0xff00 && code <= 0xff60)
      || (code >= 0xffe0 && code <= 0xffe6);
    width += wide ? 2 : 1;
  }
  return width;
}

function padDisplay(text, width) {
  const value = String(text);
  return value + ' '.repeat(Math.max(0, width - displayWidth(value)));
}

function formatLevel(entry) {
  if (!entry) return LEVEL_LABELS.unsupported;
  return LEVEL_LABELS[entry.level] || entry.level;
}

function detailOf(entry) {
  if (!entry) return '';
  return entry.evidence || entry.reason || '';
}

function renderAdapters(rows) {
  const lines = [PROVIDER_HEADER];
  for (const row of rows) {
    row.candidates.forEach((candidate, index) => {
      const state = candidate.implemented ? 'ready' : 'planned';
      const adapterLabel = index === 0 ? candidate.adapterId : `${candidate.adapterId} (fallback)`;
      lines.push([
        String(row.provider).padEnd(PROVIDER_COLUMNS[0]),
        String(row.phase).padEnd(PROVIDER_COLUMNS[1]),
        adapterLabel.padEnd(PROVIDER_COLUMNS[2]),
        state.padEnd(PROVIDER_COLUMNS[3])
      ].join('  '));
    });
  }
  const excluded = listExcludedHarnesses();
  if (excluded.length > 0) {
    lines.push('');
    lines.push('\x1b[90m不登记（不在本层范围内）:\x1b[0m');
    for (const row of excluded) lines.push(`  ${row.provider.padEnd(14)} ${row.reason}`);
  }
  return lines.join('\n');
}

function renderCapabilities(described) {
  const lines = [
    `${described.label} (${described.provider})  phase ${described.phase}`,
    described.note ? `  ${described.note}` : '',
    ''
  ].filter((line) => line !== '');
  for (const candidate of described.candidates) {
    lines.push(`${candidate.adapterId}${candidate.implemented ? '' : '  (未实现)'}`);
    lines.push(`  ${CAPABILITY_HEADER}`);
    for (const kind of INTERACTION_KINDS) {
      const entry = candidate.capabilities && candidate.capabilities.interactions[kind];
      lines.push([
        padDisplay(`  ${KIND_LABELS[kind] || kind}`, CAPABILITY_COLUMNS[0]),
        padDisplay(formatLevel(entry), CAPABILITY_COLUMNS[1])
      ].join('  ') + (detailOf(entry) ? `  ${detailOf(entry)}` : ''));
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

async function runAgentCommand(argv = [], context = {}) {
  const stdout = context.stdout || process.stdout;
  const stderr = context.stderr || process.stderr;
  const write = (text) => stdout.write(`${text}\n`);
  const writeError = (text) => stderr.write(`${text}\n`);
  const options = parseArgs(argv);

  if (options.help) {
    printHelp(write);
    return 0;
  }

  const action = options.action || 'adapters';

  if (action === 'adapters' || action === 'list') {
    const rows = describeAllProviders();
    if (options.json) {
      write(JSON.stringify({ ok: true, adapters: rows, excluded: listExcludedHarnesses() }, null, 2));
      return 0;
    }
    write(renderAdapters(rows));
    return 0;
  }

  if (action === 'capabilities') {
    if (!options.provider) {
      writeError('[aih] 用法: aih agent capabilities <provider>');
      return 1;
    }
    const described = describeProvider(options.provider);
    if (!described) {
      writeError(`[aih] 未登记的 harness: ${options.provider}（aih agent adapters 看全量）`);
      return 1;
    }
    if (options.json) {
      write(JSON.stringify({ ok: true, ...described }, null, 2));
      return 0;
    }
    write(renderCapabilities(described));
    return 0;
  }

  if (action === 'probe') {
    if (!options.provider) {
      writeError('[aih] 用法: aih agent probe <provider>');
      return 1;
    }
    try {
      const resolution = resolveAdapter(options.provider);
      const payload = {
        ok: true,
        provider: resolution.provider,
        adapter: resolution.adapterId,
        transport: resolution.capabilities.transport,
        attempted: resolution.attempted
      };
      if (options.json) write(JSON.stringify(payload, null, 2));
      else write(`${payload.provider} -> ${payload.adapter} (${payload.transport})`);
      return 0;
    } catch (error) {
      const payload = {
        ok: false,
        provider: options.provider,
        error: error && error.code ? error.code : 'agent_session_probe_failed',
        attempted: (error && error.details && error.details.attempted) || []
      };
      if (options.json) write(JSON.stringify(payload, null, 2));
      else {
        writeError(`[aih] ${payload.provider}: ${payload.error}`);
        for (const entry of payload.attempted) {
          writeError(`  ${entry.adapterId}  ${entry.implemented ? 'ready' : 'missing'}`);
        }
      }
      return 1;
    }
  }

  writeError(`[aih] 未知子命令: ${action}（adapters | capabilities | probe）`);
  return 1;
}

module.exports = {
  KIND_LABELS,
  LEVEL_LABELS,
  USAGE,
  isAdapterImplemented,
  listAdapterCapabilityRows,
  parseArgs,
  renderAdapters,
  renderCapabilities,
  runAgentCommand
};
