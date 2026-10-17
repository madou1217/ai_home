#!/usr/bin/env node
'use strict';

/**
 * 清点项目里的环境变量（重点是 `AIH_*` 这套「环境准入」开关），生成：
 *   docs/architecture/env-flags.md             人读清单（分类 / 读取次数 / 反模式 / 新增规则）
 *   docs/architecture/env-flags.snapshot.json  机器快照（新变量必须登记，见 test/env-inventory.test.js）
 *
 * 用法：
 *   npm run env:inventory              # 打印 Markdown
 *   npm run env:inventory -- --write   # 写文件
 *   npm run env:inventory -- --json    # 打印 JSON 快照
 *
 * 只读源码，不运行、不联网。
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DOC_PATH = path.join(ROOT, 'docs', 'architecture', 'env-flags.md');
const SNAPSHOT_PATH = path.join(ROOT, 'docs', 'architecture', 'env-flags.snapshot.json');
const SCAN_ROOTS = ['lib', 'bin', 'scripts', 'core'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'bin/native']);

// 已知的「一键多名」同义变量（历史上都进过部署脚本），必须在文档里点名而不是装作不存在。
const KNOWN_SYNONYMS = Object.freeze([
  { names: ['AIH_HOME_DIR', 'AIH_HOME', 'AI_HOME'], canonical: 'AIH_HOME_DIR（`lib/runtime/aih-home.js` 是唯一解析处）', note: '三个名字是同义别名，不是三种模式' },
  { names: ['AIH_SERVER_MANAGEMENT_KEY'], canonical: 'AIH_SERVER_MANAGEMENT_KEY', note: '文档/示例里出现过的 AIH_MANAGEMENT_KEY 不是输入变量（只在脚本示例里当下发值用）' }
]);

// ENABLE/DISABLE 成对开关是反模式：一个语义两条变量，很容易两边都设、互相打架。
// 允许保留的只在这里登记（新增必须给出理由，否则守卫测试会红）。
const ALLOWED_FLAG_PAIRS = Object.freeze([
  { stem: 'AIH_CODEX_{ENABLE,DISABLE}_REMOTE_PROXY', reason: '历史兼容：DISABLE=1 仍生效，新写法统一用 ENABLE=1' }
]);

const READ_PATTERNS = [
  /process\.env\.([A-Z][A-Z0-9_]+)/g,
  /process\.env\[['"]([A-Z][A-Z0-9_]+)['"]\]/g,
  /\benv\.([A-Z][A-Z0-9_]+)\b/g,
  /\benv\[['"]([A-Z][A-Z0-9_]+)['"]\]/g,
  /isEnvEnabled\(\s*['"]([A-Z][A-Z0-9_]+)['"]/g,
  /os\.Getenv\("([A-Z][A-Z0-9_]+)"\)/g,
  /LookupEnv\("([A-Z][A-Z0-9_]+)"\)/g
];
const NAME_CONSTANT_PATTERN = /(?:const|let|var)\s+([A-Z][A-Z0-9_]*_ENV)\s*=\s*['"](AIH_[A-Z0-9_]+)['"]/g;
const LITERAL_PATTERN = /['"](AIH_[A-Z0-9_]+)['"]/g;

function listFiles(dir, out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_error) {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const relative = path.relative(ROOT, full).split(path.sep).join('/');
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || relative.startsWith('bin/native')) continue;
      listFiles(full, out);
      continue;
    }
    if (!/\.(js|mjs|cjs|ts|go)$/.test(entry.name)) continue;
    out.push(full);
  }
  return out;
}

function categorize(name) {
  if (/(^|_)(HOME|HOME_DIR|DIR|PATH|WORKSPACE|REPO|ROOT)($|_)/.test(name)) return 'path';
  if (/(^|_)(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|COOKIE|AUTH)($|_)/.test(name)) return 'credential';
  if (/(^|_)(URL|HOST|PORT|PROXY|NO_PROXY|WS|TLS|ICE|TURN|ENDPOINT|SSH)($|_)/.test(name)) return 'network';
  if (/(^|_)(NO_|DISABLE|ENABLE|FORCE|ALLOW|SKIP|ONLY|DRY|DEBUG|MOCK)/.test(name)) return 'flag';
  if (/(_MS|_TTL|_LIMIT|_MAX|_MIN|_SIZE|_INTERVAL|_TIMEOUT|_COUNT|_BATCH|_RETRY|_DELAY)/.test(name)) return 'tuning';
  if (/(TEST|SMOKE|E2E|PROBE|FAKE|STUB)/.test(name)) return 'test';
  return 'plumbing';
}

function collect() {
  const files = SCAN_ROOTS.flatMap((root) => listFiles(path.join(ROOT, root)));
  const vars = new Map();
  const nameConstants = new Map();

  const touch = (name) => {
    if (!name || !name.startsWith('AIH_')) return null;
    if (!vars.has(name)) {
      vars.set(name, { name, category: categorize(name), reads: 0, literals: 0, files: new Set(), aliasConstants: new Set() });
    }
    return vars.get(name);
  };

  for (const file of files) {
    let source = '';
    try {
      source = fs.readFileSync(file, 'utf8');
    } catch (_error) {
      continue;
    }
    const relative = path.relative(ROOT, file).split(path.sep).join('/');
    for (const pattern of READ_PATTERNS) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(source))) {
        const entry = touch(match[1]);
        if (!entry) continue;
        entry.reads += 1;
        entry.files.add(relative);
      }
    }
    NAME_CONSTANT_PATTERN.lastIndex = 0;
    let constMatch;
    while ((constMatch = NAME_CONSTANT_PATTERN.exec(source))) {
      nameConstants.set(constMatch[1], constMatch[2]);
      const entry = touch(constMatch[2]);
      if (entry) entry.aliasConstants.add(constMatch[1]);
    }
    LITERAL_PATTERN.lastIndex = 0;
    let literalMatch;
    while ((literalMatch = LITERAL_PATTERN.exec(source))) {
      const entry = touch(literalMatch[1]);
      if (!entry) continue;
      entry.literals += 1;
      entry.files.add(relative);
    }
  }

  const entries = Array.from(vars.values())
    .map((entry) => ({
      name: entry.name,
      category: entry.category,
      reads: entry.reads,
      literals: entry.literals,
      files: Array.from(entry.files).sort(),
      aliasConstants: Array.from(entry.aliasConstants).sort()
    }))
    .sort((left, right) => right.reads - left.reads || left.name.localeCompare(right.name));

  return { entries, nameConstants: Object.fromEntries(Array.from(nameConstants.entries()).sort()) };
}

function findFlagPairs(entries) {
  const pairs = [];
  for (const entry of entries) {
    if (!/ENABLE/.test(entry.name)) continue;
    const disabled = entry.name.replace('ENABLE', 'DISABLE');
    if (entries.some((other) => other.name === disabled)) {
      pairs.push({ enable: entry.name, disable: disabled });
    }
  }
  return pairs;
}

const CATEGORY_LABELS = Object.freeze({
  path: '数据/目录/仓库路径',
  credential: '凭据与密钥（文档只写变量名，绝不放真实值）',
  network: '端点 / 代理 / 端口',
  flag: '开关与逃生门（环境准入）',
  tuning: '可调参数（超时 / TTL / 上限）',
  test: '测试与探针专用',
  plumbing: '内部管道（进程间传递的身份 / 标记）'
});

function renderMarkdown(entries, generatedAt) {
  const byCategory = {};
  for (const entry of entries) {
    byCategory[entry.category] = byCategory[entry.category] || [];
    byCategory[entry.category].push(entry);
  }
  const lines = [];
  lines.push('# 环境变量清单（环境准入）');
  lines.push('');
  lines.push(`> 生成命令：\`npm run env:inventory -- --write\`　生成时间：${generatedAt}`);
  lines.push(`> 覆盖 \`${SCAN_ROOTS.join(' / ')}\`，共 **${entries.length}** 个 \`AIH_*\` 变量。`);
  lines.push('> 本文件是**唯一清单**：新增环境变量必须重跑本命令，否则 `test/env-inventory.test.js` 会红。');
  lines.push('');
  lines.push('## 新增环境变量的规则');
  lines.push('');
  lines.push('1. **一个语义只用一个名字**；同义别名只能有一个解析处（参照 `lib/runtime/aih-home.js`）。');
  lines.push('2. **不要用 `ENABLE`/`DISABLE` 两个变量表达一个开关**；确需兼容历史写法时，登记到「成对开关」一节并说明。');
  lines.push('3. 可调参数（超时 / TTL / 上限）优先放进 `lib/cli/config/constants.js` 的常量，**不要**变成环境变量；');
  lines.push('   必须是环境变量的（部署差异），命名带单位（`_MS`）并写明默认值。');
  lines.push('4. 测试专用变量一律 `AIH_TEST_*` 前缀，禁止进入生产路径的默认判断。');
  lines.push('5. 新增后跑 `npm run env:inventory -- --write`，把用途写进下表对应分类。');
  lines.push('');
  lines.push('## 分类概览');
  lines.push('');
  lines.push('| 分类 | 数量 | 含义 |');
  lines.push('| --- | --- | --- |');
  for (const category of ['path', 'network', 'flag', 'tuning', 'credential', 'test', 'plumbing']) {
    const list = byCategory[category] || [];
    if (!list.length) continue;
    lines.push(`| ${category} | ${list.length} | ${CATEGORY_LABELS[category]} |`);
  }
  lines.push('');
  lines.push('## 反模式与本次梳理发现');
  lines.push('');
  lines.push('### 同义别名（一个语义多个名字）');
  lines.push('');
  lines.push('| 名字 | 唯一解析处 | 说明 |');
  lines.push('| --- | --- | --- |');
  for (const item of KNOWN_SYNONYMS) {
    lines.push(`| ${item.names.map((name) => `\`${name}\``).join(' / ')} | ${item.canonical} | ${item.note} |`);
  }
  lines.push('');
  lines.push('### 成对开关（ENABLE / DISABLE）');
  lines.push('');
  const pairs = findFlagPairs(entries);
  if (pairs.length) {
    lines.push('| ENABLE | DISABLE | 处理 |');
    lines.push('| --- | --- | --- |');
    for (const pair of pairs) {
      const prefix = pair.enable.replace('_ENABLE_', '_');
      const allowed = ALLOWED_FLAG_PAIRS.find((item) => item.stem.includes(pair.enable.replace('_ENABLE_', '_{ENABLE,DISABLE}_')));
      lines.push(`| \`${pair.enable}\` | \`${pair.disable}\` | ${allowed ? allowed.reason : '⚠️ 未登记：请合并成一个开关'} |`);
    }
  } else {
    lines.push('（无）');
  }
  lines.push('');
  lines.push('### 影响面最大的变量（读取次数前 15）');
  lines.push('');
  lines.push('| 变量 | 分类 | 读取 | 文件数 |');
  lines.push('| --- | --- | --- | --- |');
  for (const entry of entries.slice(0, 15)) {
    lines.push(`| \`${entry.name}\` | ${entry.category} | ${entry.reads} | ${entry.files.length} |`);
  }
  lines.push('');
  for (const category of ['path', 'network', 'flag', 'tuning', 'credential', 'test', 'plumbing']) {
    const list = byCategory[category] || [];
    if (!list.length) continue;
    lines.push(`## ${category}（${CATEGORY_LABELS[category]}）`);
    lines.push('');
    lines.push('| 变量 | 读取 | 字面量 | 文件 |');
    lines.push('| --- | --- | --- | --- |');
    for (const entry of list) {
      const files = entry.files.length > 3
        ? `${entry.files.slice(0, 3).join('<br>')}<br>…共 ${entry.files.length} 个`
        : entry.files.join('<br>');
      lines.push(`| \`${entry.name}\` | ${entry.reads} | ${entry.literals} | ${files} |`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

function main() {
  const argv = process.argv.slice(2);
  const write = argv.includes('--write');
  const jsonOnly = argv.includes('--json');
  const generatedAt = new Date().toISOString();
  const { entries, nameConstants } = collect();
  const snapshot = { generatedAt, total: entries.length, nameConstants, entries };
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

module.exports = { ALLOWED_FLAG_PAIRS, KNOWN_SYNONYMS, categorize, collect, findFlagPairs, renderMarkdown };

if (require.main === module) {
  process.exit(main());
}
