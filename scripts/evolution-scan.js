#!/usr/bin/env node
'use strict';

// F12 自动进化「盲区扫描器」+ P1 review 门禁（原会话 loop 两条流程类需求的落地）。
//
// 背景（docs/session-b2ce4810-gap-tracker.md 三、流程类）：
//   - F12：loop 退化为复读，evolution-planner.ts 只有静态数据结构；
//   - P1 ：每次产出必须经 aih codex/claude 带「需求原文 + 实现结果」双 review，loop 后期从未执行。
//
// 本脚本提供两个子命令：
//   scan   解析演进矩阵 / 缺口追踪文档中的状态标记（✅🔧⚠️❌❓➖ 与 - [x]/- [ ]），
//          产出「下一轮该做什么」的规划清单（❌ > ⚠️ > ❓ 优先，附出处行号），支持 JSON / Markdown；
//          内置大文件哨兵：扫描 lib/ application/ core/ web/src 下超阈值源码文件
//          （>150KB 预警 / >200KB 超标），列入 nextActions（优先级等同 ⚠️）。
//   review 给定「需求条目 + 实现结果摘要」，组装标准化 review prompt（需求原文、实现证据、
//          验收问题清单），可经 aih codex / aih claude 实际执行双模型 review。
//
// 设计：纯函数核心（parse 文档 / 组装 prompt / 构造运行计划）+ 薄 CLI 壳，
//       可被 loop 或人工直接调用；aih 调用惯例复用 scripts/ai-ui-delegate.js（DRY）。
//
// 用法：
//   node scripts/evolution-scan.js                                  # 扫描默认两份文档，输出 Markdown 到 stdout
//   node scripts/evolution-scan.js scan --format=json --out=tmp/scan.json
//   node scripts/evolution-scan.js review --requirement "F12 ..." --result "已实现 ..." \
//        --evidence "test/x.test.js 5 项通过" --provider both --dry-run
//   node scripts/evolution-scan.js review --requirement "..." --result "..." --provider codex --execute

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { stripAnsi, writeRawOutput } = require('./ai-ui-delegate');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_MATRIX_DOC = path.join(REPO_ROOT, 'docs', 'dsh-harmonyos-evolution-matrix.md');
const DEFAULT_GAPS_DOC = path.join(REPO_ROOT, 'docs', 'session-b2ce4810-gap-tracker.md');
const DEFAULT_REVIEW_OUTPUT_DIR = path.join('tmp', 'evolution-review');
const DEFAULT_CLAUDE_MODEL = 'claude-opus-4.6-thinking';
const DEFAULT_CODEX_ACCOUNT = '1';

// ---- 大文件哨兵阈值 -----------------------------------------------------------
// 背景：曾有单文件 285KB 超过工具 256KB 读取上限导致处理失败；防回弹，
// loop 每轮扫描时顺带检查。>150KB 预警、>200KB 超标必须拆分。
const LARGE_FILE_SCAN_DIRS = ['lib', 'application', 'core', path.join('web', 'src')];
const LARGE_FILE_EXTENSIONS = new Set(['.js', '.ts', '.tsx', '.css']);
const LARGE_FILE_WARNING_BYTES = 150 * 1024;
const LARGE_FILE_LIMIT_BYTES = 200 * 1024;

// ---- 状态标记表 -------------------------------------------------------------
// 与 docs/session-b2ce4810-gap-tracker.md「状态图例」一致；priority 越小越需要下一轮处理。
const STATUS_MARKERS = [
  { marker: '❌', status: 'missing', priority: 0, label: '未实现' },
  { marker: '⚠', status: 'partial', priority: 1, label: '部分完成' }, // ⚠️ 含 U+FE0F 变体选择符，按 ⚠ 前缀匹配
  { marker: '❓', status: 'unknown', priority: 2, label: '状态不确定' },
  { marker: '🔧', status: 'fixed', priority: 3, label: '本次修复' },
  { marker: '✅', status: 'done', priority: 4, label: '已完成' },
  { marker: '➖', status: 'na', priority: 5, label: '不适用' }
];

// 规划清单只收录未完成项：未实现 > 部分完成 > 状态不确定
const ACTIONABLE_STATUSES = new Set(['missing', 'partial', 'unknown']);

function findMarker(cellText) {
  const text = String(cellText || '');
  for (const entry of STATUS_MARKERS) {
    if (text.includes(entry.marker)) return entry;
  }
  return null;
}

function splitTableRow(line) {
  return String(line || '')
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split(/(?<!\\)\|/) // Markdown 表格内 `\|` 是字面量管道符，不是列分隔
    .map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

function isSeparatorRow(cells) {
  return cells.length > 0 && cells.every((cell) => /^:?-{2,}:?$/.test(cell));
}

function cleanTitle(text) {
  return String(text || '')
    .replace(/\*\*/g, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function isIdCell(text) {
  return /^(?:[FBDP]|TODO-[A-Z])?\d+(?:\.\d+)?$/.test(String(text || '').trim());
}

// ---- 大文件哨兵（薄文件系统壳 + 纯函数） -----------------------------------------

/**
 * 递归扫描指定目录下的源码文件，返回超阈值大文件清单（按字节数降序）。
 * >LARGE_FILE_LIMIT_BYTES 记为 exceeded（超标，必须拆分）；
 * >LARGE_FILE_WARNING_BYTES 记为 warning（预警）。目录不存在/不可读时静默跳过，
 * 哨兵不阻塞扫描主流程；node_modules 与隐藏目录不扫（只盯手写源码）。
 */
function scanLargeFiles(rootDir, options = {}) {
  const dirs = options.dirs || LARGE_FILE_SCAN_DIRS;
  const extensions = options.extensions || LARGE_FILE_EXTENSIONS;
  const warningBytes = options.warningBytes || LARGE_FILE_WARNING_BYTES;
  const limitBytes = options.limitBytes || LARGE_FILE_LIMIT_BYTES;
  const violations = [];

  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        walk(fullPath);
      } else if (entry.isFile() && extensions.has(path.extname(entry.name))) {
        const { size } = fs.statSync(fullPath);
        if (size > limitBytes) {
          violations.push({ path: path.relative(rootDir, fullPath), bytes: size, severity: 'exceeded' });
        } else if (size > warningBytes) {
          violations.push({ path: path.relative(rootDir, fullPath), bytes: size, severity: 'warning' });
        }
      }
    }
  };

  for (const dir of dirs) {
    walk(path.resolve(rootDir, dir));
  }
  return violations.sort((a, b) => b.bytes - a.bytes);
}

/**
 * 把大文件哨兵结果转成规划清单条目：优先级等同 ⚠️（partial，priority 1），
 * 让 loop 每轮扫描时与未完成事项同列出现、逐项消化拆分。
 */
function buildLargeFileActions(violations) {
  return (violations || []).map((violation) => ({
    id: violation.path,
    title: violation.severity === 'exceeded'
      ? `大文件超标 ${(violation.bytes / 1024).toFixed(1)}KB，必须按模块/provider 拆分`
      : `大文件预警 ${(violation.bytes / 1024).toFixed(1)}KB，逼近拆分红线`,
    status: 'partial',
    statusLabel: violation.severity === 'exceeded' ? '大文件超标' : '大文件预警',
    priority: 1,
    heading: '大文件哨兵',
    source: violation.path,
    line: null, // 文件级条目无行号
    kind: 'large-file'
  }));
}

// ---- 文档解析（纯函数） ------------------------------------------------------

/**
 * 解析一份含状态标记的 Markdown 追踪文档。
 * 识别两类条目：
 *   1. 表格行：表头定位「需求/功能/缺陷」列与「状态」列，逐行取标记；
 *   2. 复选框行：- [x] / - [ ]。
 * @returns {{ items: Array, headingTrail: string[] }}
 */
function parseTrackingDocument(markdown, source) {
  const lines = String(markdown || '').split(/\r?\n/);
  const items = [];
  let heading = '';
  // 当前表格的列定位：titleCol = 需求/功能/缺陷列，statusCol = 状态列
  let tableHeader = null;

  lines.forEach((line, index) => {
    const lineNo = index + 1;
    const headingMatch = line.match(/^#{2,4}\s+(.+?)\s*$/);
    if (headingMatch) {
      heading = cleanTitle(headingMatch[1].replace(/^[一二三四五六\d.、\s]+/, ''));
      tableHeader = null;
      return;
    }

    const checkboxMatch = line.match(/^\s*[-*]\s*\[( |x|X)\]\s*(.+)$/);
    if (checkboxMatch) {
      const rawTitle = checkboxMatch[2];
      const boldMatch = rawTitle.match(/\*\*(.+?)\*\*/);
      const title = cleanTitle(boldMatch ? boldMatch[1] : rawTitle);
      const idMatch = title.match(/\b(TODO-[A-Z]\d+)\b/);
      items.push({
        id: idMatch ? idMatch[1] : `${source}#L${lineNo}`,
        title,
        status: checkboxMatch[1].toLowerCase() === 'x' ? 'done' : 'pending',
        statusLabel: checkboxMatch[1].toLowerCase() === 'x' ? '已完成' : '待办',
        priority: checkboxMatch[1].toLowerCase() === 'x' ? 4 : 1,
        heading,
        source,
        line: lineNo
      });
      return;
    }

    if (!/^\s*\|/.test(line)) {
      tableHeader = null;
      return;
    }
    const cells = splitTableRow(line);
    if (isSeparatorRow(cells)) return;

    // 表头行：确定列定位。分隔行之后的表格以首行数据行前的表头为准。
    if (!tableHeader) {
      const nextLine = lines[index + 1] || '';
      if (/^\s*\|/.test(nextLine) && isSeparatorRow(splitTableRow(nextLine))) {
        const titleCol = cells.findIndex((cell) => /需求|功能|特性|缺陷/.test(cell));
        const statusCol = cells.findIndex((cell) => /状态|结论/.test(cell));
        tableHeader = { titleCol, statusCol };
      }
      return;
    }

    // 数据行：状态列取标记；状态列没有标记时回退为整行首个含标记的单元格。
    let markerEntry = null;
    if (tableHeader.statusCol >= 0 && cells[tableHeader.statusCol] !== undefined) {
      markerEntry = findMarker(cells[tableHeader.statusCol]);
    }
    if (!markerEntry) {
      for (const cell of cells) {
        markerEntry = findMarker(cell);
        if (markerEntry) break;
      }
    }
    if (!markerEntry) return; // 无状态标记的行（如「本次修复清单」表）不纳入追踪

    let title = '';
    if (tableHeader.titleCol >= 0 && cells[tableHeader.titleCol]) {
      title = cleanTitle(cells[tableHeader.titleCol]);
    }
    if (!title) {
      // 兜底：取除状态单元格外的最长文本单元格
      const candidates = cells.filter((cell) => cell && !findMarker(cell));
      title = cleanTitle(candidates.sort((a, b) => b.length - a.length)[0] || '');
    }
    const idCell = cells.find(isIdCell);

    items.push({
      id: idCell || `${source}#L${lineNo}`,
      title,
      status: markerEntry.status,
      statusLabel: markerEntry.label,
      priority: markerEntry.priority,
      heading,
      source,
      line: lineNo
    });
  });

  return { items };
}

/**
 * 汇总多份文档，产出「下一轮该做什么」的规划清单。
 * 未完成项按优先级排序（❌ > ⚠️ > ❓），同级保持文档顺序，附出处文件与行号。
 * options.largeFileViolations 注入大文件哨兵结果（scanLargeFiles 的输出），
 * 以 priority 1（等同 ⚠️）并入 nextActions。
 */
function buildEvolutionPlan(documents, now = new Date(), options = {}) {
  const allItems = [];
  for (const doc of documents) {
    const { items } = parseTrackingDocument(doc.markdown, doc.source);
    allItems.push(...items);
  }

  const totals = {};
  for (const item of allItems) {
    totals[item.status] = (totals[item.status] || 0) + 1;
  }

  const largeFileViolations = Array.isArray(options.largeFileViolations)
    ? options.largeFileViolations
    : [];

  const nextActions = allItems
    .filter((item) => ACTIONABLE_STATUSES.has(item.status))
    .concat(buildLargeFileActions(largeFileViolations))
    .sort((a, b) => a.priority - b.priority)
    .map((item, index) => ({
      rank: index + 1,
      id: item.id,
      title: item.title,
      status: item.status,
      statusLabel: item.statusLabel,
      heading: item.heading,
      source: item.source,
      line: item.line,
      kind: item.kind || 'tracking'
    }));

  return {
    generatedAt: now.toISOString(),
    sources: documents.map((doc) => doc.source),
    totals,
    trackedItems: allItems.length,
    largeFileViolations,
    nextActions
  };
}

function renderPlanMarkdown(plan) {
  const violations = plan.largeFileViolations || [];
  const exceededCount = violations.filter((violation) => violation.severity === 'exceeded').length;
  const lines = [
    '# 自动进化盲区扫描 · 下一轮规划清单',
    '',
    `> 生成时间：${plan.generatedAt}`,
    `> 数据源：${plan.sources.join('、')}`,
    `> 追踪条目 ${plan.trackedItems} 项；待处理 ${plan.nextActions.length} 项` +
      `（❌ ${plan.totals.missing || 0} / ⚠️ ${plan.totals.partial || 0} / ❓ ${plan.totals.unknown || 0}）` +
      (violations.length > 0
        ? `；大文件哨兵 ${violations.length} 项（超标 ${exceededCount} / 预警 ${violations.length - exceededCount}）`
        : ''),
    '',
    '## 下一轮该做什么（❌ 未实现 > ⚠️ 部分完成 > ❓ 状态不确定）',
    ''
  ];
  if (plan.nextActions.length === 0) {
    lines.push('- 无待处理项：全部条目已闭环或不适用。');
  }
  for (const action of plan.nextActions) {
    const location = action.line ? `${action.source}:${action.line}` : action.source;
    lines.push(
      `${action.rank}. [${action.statusLabel}] **${action.id}** ${action.title}` +
        ` — ${location}（${action.heading || '未分组'}）`
    );
  }
  lines.push('');
  return lines.join('\n');
}

// ---- P1 review 门禁（纯函数 + 薄执行壳） -------------------------------------

const ACCEPTANCE_QUESTIONS = [
  '需求原文的每一条要求是否都被实现结果完整覆盖？逐条对照作答。',
  '实现是否存在边界遗漏、与需求形态不符或只做点状修复的问题？',
  '改动是否符合仓库既有代码风格与架构边界（先读后改、最小改动）？',
  '证据是否真实可复核（测试命令、实测结果、文件:行号），还是仅口头声称？',
  '结论：逐项给出 PASS / FAIL 及理由；任一 FAIL 必须列出必须返工的具体事项。'
];

/**
 * 组装标准化 review prompt：需求原文 + 实现结果摘要 + 实现证据 + 验收问题清单。
 * 门禁语义：prompt 强制 reviewer 带需求对照结果逐项裁决，不接受无证据通过。
 */
function buildReviewPrompt(input) {
  const requirement = String(input.requirement || '').trim();
  const result = String(input.result || '').trim();
  if (!requirement) throw new Error('buildReviewPrompt: requirement is required');
  if (!result) throw new Error('buildReviewPrompt: result is required');
  const evidence = String(input.evidence || '').trim();
  const files = Array.isArray(input.files) ? input.files.filter(Boolean) : [];

  return [
    '你是 AI Home 项目的独立质量评审员。这是一次强制 review 门禁：未通过前产出不得标记完成。',
    '',
    '【需求原文】',
    requirement,
    '',
    '【实现结果摘要】',
    result,
    '',
    '【实现证据】',
    ...(files.length > 0 ? [`改动文件：${files.join('、')}`] : []),
    evidence || '（未提供，必须按 FAIL 处理并要求补充证据）',
    '',
    '【验收问题清单】',
    ...ACCEPTANCE_QUESTIONS.map((question, index) => `${index + 1}. ${question}`),
    '',
    '只输出结构化评审结论（逐条 PASS/FAIL + 理由 + 总结论），不要修改任何文件。'
  ].join('\n');
}

/**
 * 构造双模型 review 运行计划，aih 调用惯例复用 scripts/ai-ui-delegate.js：
 *   claude: aih claude -p <prompt> --model <model> --no-session-persistence
 *   codex : aih codex <account> exec <prompt>（exec 为 codex 的 headless 触发子命令）
 */
function buildReviewRuns(provider, prompt, options = {}) {
  const runs = [];
  if (provider === 'claude' || provider === 'both') {
    runs.push({
      provider: 'claude',
      fileLabel: 'claude-review',
      command: 'aih',
      args: ['claude', '-p', prompt, '--model', options.model || DEFAULT_CLAUDE_MODEL, '--no-session-persistence']
    });
  }
  if (provider === 'codex' || provider === 'both') {
    runs.push({
      provider: 'codex',
      fileLabel: 'codex-review',
      command: 'aih',
      args: ['codex', options.codexAccount || DEFAULT_CODEX_ACCOUNT, 'exec', prompt]
    });
  }
  return runs;
}

function runReview(run, options) {
  if (options.dryRun) {
    return { provider: run.provider, command: [run.command, ...run.args].join(' '), outputFile: null };
  }
  const child = spawnSync(run.command, run.args, {
    cwd: options.cwd || REPO_ROOT,
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 10
  });
  const combinedOutput = `${child.stdout || ''}\n${child.stderr || ''}`;
  if (child.error) throw child.error;
  const outputDir = options.outputDir || DEFAULT_REVIEW_OUTPUT_DIR;
  if (child.status !== 0) {
    const rawOutputFile = writeRawOutput(outputDir, run.fileLabel, run.provider, combinedOutput);
    throw new Error(`${run.command} ${run.args[0]} review exited with ${child.status}; raw output: ${rawOutputFile}`);
  }
  fs.mkdirSync(outputDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputFile = path.join(outputDir, `${stamp}-${run.fileLabel}.txt`);
  fs.writeFileSync(outputFile, `${stripAnsi(combinedOutput)}\n`, 'utf8');
  return { provider: run.provider, outputFile };
}

// ---- CLI 壳 ------------------------------------------------------------------

function parseArgs(argv) {
  const options = {
    command: 'scan',
    format: 'md',
    matrixDoc: DEFAULT_MATRIX_DOC,
    gapsDoc: DEFAULT_GAPS_DOC,
    out: '',
    provider: 'both',
    execute: false,
    dryRun: true,
    printPrompt: false,
    requirement: '',
    result: '',
    evidence: '',
    files: [],
    model: DEFAULT_CLAUDE_MODEL,
    codexAccount: DEFAULT_CODEX_ACCOUNT,
    outputDir: DEFAULT_REVIEW_OUTPUT_DIR
  };
  // 统一 --key=value 与 --key value 两种形式
  const args = argv.flatMap((arg) => {
    const inline = String(arg).match(/^(--[^=]+)=(.*)$/);
    return inline ? [inline[1], inline[2]] : [arg];
  });
  if (args[0] === 'scan' || args[0] === 'review') {
    options.command = args.shift();
  }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];
    const takeValue = (name) => {
      if (!next) throw new Error(`${name} requires a value`);
      index += 1;
      return next;
    };
    if (arg === '--format') {
      options.format = takeValue('--format');
    } else if (arg === '--matrix') {
      options.matrixDoc = takeValue('--matrix');
    } else if (arg === '--gaps') {
      options.gapsDoc = takeValue('--gaps');
    } else if (arg === '--out') {
      options.out = takeValue('--out');
    } else if (arg === '--provider') {
      options.provider = takeValue('--provider');
    } else if (arg === '--requirement') {
      options.requirement = takeValue('--requirement');
    } else if (arg === '--result') {
      options.result = takeValue('--result');
    } else if (arg === '--evidence') {
      options.evidence = takeValue('--evidence');
    } else if (arg === '--files') {
      options.files = takeValue('--files').split(',').map((file) => file.trim()).filter(Boolean);
    } else if (arg === '--model') {
      options.model = takeValue('--model');
    } else if (arg === '--codex-account') {
      options.codexAccount = takeValue('--codex-account');
    } else if (arg === '--output-dir') {
      options.outputDir = takeValue('--output-dir');
    } else if (arg === '--execute') {
      options.execute = true;
      options.dryRun = false;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
      options.execute = false;
    } else if (arg === '--print-prompt') {
      options.printPrompt = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function showHelp(log = console.log) {
  log(`AI Home 自动进化盲区扫描器 + review 门禁

Usage:
  node scripts/evolution-scan.js [scan] [--format=md|json] [--matrix=<path>] [--gaps=<path>] [--out=<file>]
  node scripts/evolution-scan.js review --requirement "<需求原文>" --result "<实现结果摘要>"
      [--evidence "<测试/实测证据>"] [--files a.js,b.js] [--provider codex|claude|both]
      [--model <claude-model>] [--codex-account <id>] [--dry-run|--execute] [--print-prompt]

Notes:
  scan   解析状态标记 ✅🔧⚠️❌❓➖ 与 - [x]/- [ ]，产出下一轮规划清单（❌ > ⚠️ > ❓ 优先，附行号）；
         内置大文件哨兵：lib/ application/ core/ web/src 下 >150KB 预警、>200KB 超标，
         列入 nextActions（优先级等同 ⚠️）。
  review 组装「需求原文 + 实现证据 + 验收问题清单」review prompt；默认 --dry-run 只打印命令，
         --execute 才真正调用 aih codex/claude 执行（消耗 token）。
`);
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    showHelp();
    return null;
  }

  if (options.command === 'review') {
    const prompt = buildReviewPrompt({
      requirement: options.requirement,
      result: options.result,
      evidence: options.evidence,
      files: options.files
    });
    if (options.printPrompt) {
      console.log(prompt);
    }
    const runs = buildReviewRuns(options.provider, prompt, options);
    const results = runs.map((run) => runReview(run, options));
    for (const result of results) {
      if (result.outputFile) {
        console.log(`[evolution-review] ${result.provider} -> ${result.outputFile}`);
      } else {
        console.log(`[evolution-review] ${result.provider} dry-run: ${result.command}`);
      }
    }
    return results;
  }

  const documents = [options.matrixDoc, options.gapsDoc].map((docPath) => ({
    source: path.relative(REPO_ROOT, docPath) || docPath,
    markdown: fs.readFileSync(docPath, 'utf8')
  }));
  const largeFileViolations = scanLargeFiles(REPO_ROOT);
  const plan = buildEvolutionPlan(documents, new Date(), { largeFileViolations });
  const output = options.format === 'json'
    ? `${JSON.stringify(plan, null, 2)}\n`
    : renderPlanMarkdown(plan);
  if (options.out) {
    fs.mkdirSync(path.dirname(options.out), { recursive: true });
    fs.writeFileSync(options.out, output, 'utf8');
    console.log(`[evolution-scan] ${options.format} -> ${options.out}`);
  } else {
    process.stdout.write(output);
  }
  return plan;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[evolution-scan] ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  ACCEPTANCE_QUESTIONS,
  DEFAULT_MATRIX_DOC,
  DEFAULT_GAPS_DOC,
  LARGE_FILE_EXTENSIONS,
  LARGE_FILE_LIMIT_BYTES,
  LARGE_FILE_SCAN_DIRS,
  LARGE_FILE_WARNING_BYTES,
  STATUS_MARKERS,
  buildEvolutionPlan,
  buildLargeFileActions,
  buildReviewPrompt,
  buildReviewRuns,
  findMarker,
  main,
  parseArgs,
  parseTrackingDocument,
  renderPlanMarkdown,
  runReview,
  scanLargeFiles
};
