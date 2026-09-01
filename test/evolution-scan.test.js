'use strict';

// scripts/evolution-scan.js 的行为测试：
//   1. 扫描器解析正确性（小样例矩阵文档：表格标记、复选框、优先级排序、出处行号）；
//   2. review prompt 组装必须包含需求原文与实现结果字段；
//   3. 大文件哨兵：超阈值文件进 nextActions（优先级等同 ⚠️），未超/非源码/范围外不进。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  LARGE_FILE_LIMIT_BYTES,
  LARGE_FILE_WARNING_BYTES,
  buildEvolutionPlan,
  buildReviewPrompt,
  buildReviewRuns,
  findMarker,
  parseArgs,
  parseTrackingDocument,
  renderPlanMarkdown,
  scanLargeFiles
} = require('../scripts/evolution-scan');

const SAMPLE_MATRIX = [
  '# 样例演进矩阵',
  '',
  '## 一、功能矩阵',
  '',
  '| 页面 / 模块 | 序号 | 核心功能 / 设计特性 | 状态 | 关键实现文件 |',
  '| :--- | :---: | :--- | :---: | :--- |',
  '| **会话** | 1.1 | **已完成特性甲** | ✅ **已完成** | `a.ts` |',
  '| | 1.2 | **部分完成特性乙** | ⚠️ **部分完成** | `b.ts` |',
  '| | 1.3 | **未实现特性丙** | ❌ | `c.ts` |',
  '',
  '## 二、TODO 清单',
  '- [x] **TODO-A1 (已完成事项)**：done',
  '- [ ] **TODO-A2 (待办事项)**：todo',
  ''
].join('\n');

const SAMPLE_GAPS = [
  '# 样例缺口追踪表',
  '',
  '## 三、流程类',
  '',
  '| # | 需求(出处) | 审计结论 | 当前状态 |',
  '|---|------------|----------|----------|',
  '| 9 | 每轮 review(L3027) | 从未执行 | ❌(流程层面) |',
  '| 10 | 自动进化(L7232) | 静态数据结构 | ❌ |',
  '| 11 | 需求对照表(L10084) | 本文档即交付物 | 🔧 |',
  '| 12 | 状态存疑项 | 未复核 | ❓ |',
  '| 13 | 三栏同屏(左树 \\| 中轨迹 \\| 右终端) | 互斥标签页 | ❌ |',
  '',
  '## 四、修复清单（无状态标记，不应纳入）',
  '',
  '| 改动 | 文件 | 验证 |',
  '|------|------|------|',
  '| 某修复 | `x.js` | 测试通过 |',
  ''
].join('\n');

test('findMarker 识别全部状态标记', () => {
  assert.equal(findMarker('✅ **已完成**').status, 'done');
  assert.equal(findMarker('⚠️ 部分完成').status, 'partial');
  assert.equal(findMarker('❌(流程层面)').status, 'missing');
  assert.equal(findMarker('❓').status, 'unknown');
  assert.equal(findMarker('🔧(点状修复)').status, 'fixed');
  assert.equal(findMarker('➖ 不适用').status, 'na');
  assert.equal(findMarker('普通文本'), null);
});

test('parseTrackingDocument 解析表格行：状态、标题、出处行号', () => {
  const { items } = parseTrackingDocument(SAMPLE_MATRIX, 'docs/sample-matrix.md');
  assert.equal(items.length, 5);

  const done = items.find((item) => item.id === '1.1');
  assert.equal(done.status, 'done');
  assert.equal(done.title, '已完成特性甲');
  assert.equal(done.source, 'docs/sample-matrix.md');
  assert.equal(done.line, 7);

  const partial = items.find((item) => item.id === '1.2');
  assert.equal(partial.status, 'partial');
  assert.equal(partial.title, '部分完成特性乙');

  const missing = items.find((item) => item.id === '1.3');
  assert.equal(missing.status, 'missing');
});

test('parseTrackingDocument 解析复选框 TODO 行', () => {
  const { items } = parseTrackingDocument(SAMPLE_MATRIX, 'docs/sample-matrix.md');
  const doneTodo = items.find((item) => item.id === 'TODO-A1');
  assert.equal(doneTodo.status, 'done');
  assert.equal(doneTodo.title, 'TODO-A1 (已完成事项)');
  const pendingTodo = items.find((item) => item.id === 'TODO-A2');
  assert.equal(pendingTodo.status, 'pending');
});

test('buildEvolutionPlan 跨文档汇总并按 ❌ > ⚠️ > ❓ 排序产出下一轮清单', () => {
  const plan = buildEvolutionPlan([
    { source: 'docs/sample-matrix.md', markdown: SAMPLE_MATRIX },
    { source: 'docs/sample-gaps.md', markdown: SAMPLE_GAPS }
  ], new Date('2026-08-31T00:00:00.000Z'));

  assert.equal(plan.generatedAt, '2026-08-31T00:00:00.000Z');
  assert.deepEqual(plan.sources, ['docs/sample-matrix.md', 'docs/sample-gaps.md']);
  // 表格 7 行数据（3+4）+ 复选框 2 条 = 9；「修复清单」表无标记不纳入
  assert.equal(plan.trackedItems, 10);
  assert.deepEqual(plan.totals, {
    done: 2, partial: 1, missing: 4, pending: 1, fixed: 1, unknown: 1
  });

  const statuses = plan.nextActions.map((action) => action.status);
  // ❌(missing) 全部排在 ⚠️(partial) 与 ❓(unknown) 之前
  assert.deepEqual(statuses, ['missing', 'missing', 'missing', 'missing', 'partial', 'unknown']);
  // 表格内 `\|` 转义管道符不应截断标题
  const escaped = plan.nextActions.find((action) => action.id === '13');
  assert.equal(escaped.title, '三栏同屏(左树 | 中轨迹 | 右终端)');
  // 附出处行号
  const first = plan.nextActions[0];
  assert.equal(first.id, '1.3');
  assert.equal(first.source, 'docs/sample-matrix.md');
  assert.equal(first.line, 9);
  assert.equal(first.rank, 1);
});

test('renderPlanMarkdown 输出含排序清单与出处的 Markdown', () => {
  const plan = buildEvolutionPlan([
    { source: 'docs/sample-matrix.md', markdown: SAMPLE_MATRIX },
    { source: 'docs/sample-gaps.md', markdown: SAMPLE_GAPS }
  ], new Date('2026-08-31T00:00:00.000Z'));
  const markdown = renderPlanMarkdown(plan);
  assert.match(markdown, /下一轮该做什么/);
  assert.match(markdown, /docs\/sample-matrix\.md:9/);
  assert.ok(markdown.indexOf('未实现') < markdown.indexOf('状态不确定'));
});

test('buildReviewPrompt 必须包含需求原文、实现结果、证据与验收问题清单', () => {
  const prompt = buildReviewPrompt({
    requirement: 'F12：AI 自动发现并规划，双模型 review，loop 自动进化',
    result: '已实现 scripts/evolution-scan.js 盲区扫描器与 review 门禁',
    evidence: 'node --test test/evolution-scan.test.js 全部通过',
    files: ['scripts/evolution-scan.js', 'test/evolution-scan.test.js']
  });
  assert.match(prompt, /【需求原文】\nF12：AI 自动发现并规划/);
  assert.match(prompt, /【实现结果摘要】\n已实现 scripts\/evolution-scan\.js/);
  assert.match(prompt, /【实现证据】/);
  assert.match(prompt, /改动文件：scripts\/evolution-scan\.js、test\/evolution-scan\.test\.js/);
  assert.match(prompt, /node --test test\/evolution-scan\.test\.js 全部通过/);
  assert.match(prompt, /【验收问题清单】/);
  assert.match(prompt, /PASS \/ FAIL/);
});

test('buildReviewPrompt 缺需求或缺结果直接抛错（门禁不接受空输入）', () => {
  assert.throws(() => buildReviewPrompt({ requirement: '', result: 'x' }), /requirement is required/);
  assert.throws(() => buildReviewPrompt({ requirement: 'x', result: '' }), /result is required/);
});

test('buildReviewRuns 复用 aih 调用惯例：claude -p 与 codex exec', () => {
  const runs = buildReviewRuns('both', 'prompt-text', {});
  assert.equal(runs.length, 2);
  const claude = runs.find((run) => run.provider === 'claude');
  assert.equal(claude.command, 'aih');
  assert.deepEqual(claude.args.slice(0, 2), ['claude', '-p']);
  assert.equal(claude.args[2], 'prompt-text');
  assert.ok(claude.args.includes('--no-session-persistence'));
  const codex = runs.find((run) => run.provider === 'codex');
  assert.deepEqual(codex.args.slice(0, 3), ['codex', '1', 'exec']);
  assert.equal(codex.args[3], 'prompt-text');

  assert.equal(buildReviewRuns('codex', 'p', {}).length, 1);
  assert.equal(buildReviewRuns('claude', 'p', {}).length, 1);
});

test('parseArgs 支持 scan/review 子命令与 execute/dry-run 互斥', () => {
  const scan = parseArgs(['scan', '--format=json', '--out=tmp/x.json']);
  assert.equal(scan.command, 'scan');
  assert.equal(scan.format, 'json');
  assert.equal(scan.out, 'tmp/x.json');

  const review = parseArgs(['review', '--requirement', 'r', '--result', 's', '--provider', 'codex', '--execute']);
  assert.equal(review.command, 'review');
  assert.equal(review.provider, 'codex');
  assert.equal(review.execute, true);
  assert.equal(review.dryRun, false);

  const defaulted = parseArgs([]);
  assert.equal(defaulted.command, 'scan');
  assert.equal(defaulted.dryRun, true);
});

// ---- 大文件哨兵 ---------------------------------------------------------------

/** 在临时目录造一个指定字节数的稀疏文件（truncate 不落真实内容，快且省盘） */
function writeSizedFile(rootDir, relativePath, bytes) {
  const filePath = path.join(rootDir, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '');
  fs.truncateSync(filePath, bytes);
}

test('scanLargeFiles 超阈值分级：>200KB 超标、>150KB 预警，未超/非源码/范围外不报', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolution-scan-large-'));
  try {
    writeSizedFile(rootDir, path.join('lib', 'huge.js'), LARGE_FILE_LIMIT_BYTES + 1024);
    writeSizedFile(rootDir, path.join('lib', 'big.ts'), LARGE_FILE_WARNING_BYTES + 1024);
    writeSizedFile(rootDir, path.join('web', 'src', 'big.css'), LARGE_FILE_WARNING_BYTES + 512);
    writeSizedFile(rootDir, path.join('lib', 'small.js'), LARGE_FILE_WARNING_BYTES - 1); // 未超预警线
    writeSizedFile(rootDir, path.join('lib', 'notes.md'), LARGE_FILE_LIMIT_BYTES * 2);    // 非源码扩展名
    writeSizedFile(rootDir, path.join('other', 'huge.js'), LARGE_FILE_LIMIT_BYTES * 2);   // 不在扫描目录

    const violations = scanLargeFiles(rootDir);
    // 按字节数降序
    assert.deepEqual(
      violations.map((violation) => [violation.path, violation.severity]),
      [
        [path.join('lib', 'huge.js'), 'exceeded'],
        [path.join('lib', 'big.ts'), 'warning'],
        [path.join('web', 'src', 'big.css'), 'warning']
      ]
    );
    assert.ok(violations.every((violation) => violation.bytes > LARGE_FILE_WARNING_BYTES));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('scanLargeFiles 目录不存在时不抛错、返回空清单', () => {
  assert.deepEqual(scanLargeFiles(path.join(os.tmpdir(), 'evolution-scan-no-such-dir')), []);
});

test('buildEvolutionPlan 大文件哨兵进 nextActions，优先级等同 ⚠️（排在 ❌ 之后）', () => {
  const plan = buildEvolutionPlan(
    [{ source: 'docs/sample-matrix.md', markdown: SAMPLE_MATRIX }],
    new Date('2026-09-01T00:00:00.000Z'),
    {
      largeFileViolations: [
        { path: 'lib/huge.js', bytes: 210 * 1024, severity: 'exceeded' },
        { path: 'lib/big.ts', bytes: 160 * 1024, severity: 'warning' }
      ]
    }
  );

  // 排序：❌(1.3) 在前，⚠️(1.2) 与两条大文件条目同级（priority 1，稳定序）
  assert.deepEqual(
    plan.nextActions.map((action) => action.id),
    ['1.3', '1.2', 'lib/huge.js', 'lib/big.ts']
  );
  const sentinels = plan.nextActions.filter((action) => action.kind === 'large-file');
  assert.equal(sentinels.length, 2);
  assert.equal(sentinels[0].status, 'partial');
  assert.equal(sentinels[0].statusLabel, '大文件超标');
  assert.match(sentinels[0].title, /必须按模块\/provider 拆分/);
  assert.equal(sentinels[1].statusLabel, '大文件预警');
  // JSON 输出（plan 本体）带原始违规清单
  assert.equal(plan.largeFileViolations.length, 2);

  // Markdown 输出：文件级条目无行号，不应出现 `:null`
  const markdown = renderPlanMarkdown(plan);
  assert.match(markdown, /大文件哨兵 2 项（超标 1 \/ 预警 1）/);
  assert.match(markdown, /\[大文件超标\] \*\*lib\/huge\.js\*\*/);
  assert.doesNotMatch(markdown, /:null/);
});

test('buildEvolutionPlan 无大文件违规时 nextActions 不含哨兵条目', () => {
  const plan = buildEvolutionPlan(
    [{ source: 'docs/sample-matrix.md', markdown: SAMPLE_MATRIX }],
    new Date('2026-09-01T00:00:00.000Z'),
    { largeFileViolations: [] }
  );
  assert.equal(plan.nextActions.filter((action) => action.kind === 'large-file').length, 0);
  assert.doesNotMatch(renderPlanMarkdown(plan), /大文件哨兵/);
});
