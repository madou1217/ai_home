#!/usr/bin/env node
'use strict';

/**
 * 同步 third_party/models.dev 子模块到上游最新。
 *
 * 为什么需要它：模型元数据（模态、上下文窗口、价格）来自 models.dev 子模块，
 * 而子模块是「钉住某个 commit」的——上游每天更新，本仓不会自己跟进。新模型
 * 发布后若不同步，本仓就查不到它的模态与价格，只能落到正则兜底或显示为未知。
 *
 * 用法:
 *   npm run models:sync            同步到上游最新并打印变更摘要
 *   npm run models:sync -- --check 只检查落后多少，不改动工作区（CI 用）
 *
 * 同步只移动子模块指针，不自动提交：指针变更属于本仓的一次真实改动，由人决定
 * 何时纳入版本历史。
 */

const { execFileSync } = require('node:child_process');
const nodeFs = require('node:fs');
const nodePath = require('node:path');

const REPO_ROOT = nodePath.resolve(__dirname, '..');
const SUBMODULE_PATH = nodePath.join('third_party', 'models.dev');
const SUBMODULE_DIR = nodePath.join(REPO_ROOT, SUBMODULE_PATH);
const DEFAULT_BRANCH = 'dev';

/** 在子模块内运行 git，失败时抛出带命令上下文的错误。 */
function git(args, options = {}) {
  return execFileSync('git', args, {
    cwd: options.cwd || SUBMODULE_DIR,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}

/** 读取 .gitmodules 里声明的跟踪分支，缺省回落到 dev。 */
function resolveTrackedBranch() {
  try {
    const branch = git(
      ['config', '--file', '.gitmodules', `submodule.${SUBMODULE_PATH}.branch`],
      { cwd: REPO_ROOT }
    );
    return branch || DEFAULT_BRANCH;
  } catch (_error) {
    return DEFAULT_BRANCH;
  }
}

/** 统计 TOML 数据文件数量，作为同步前后的可见变化量。 */
function countProviderFiles() {
  let count = 0;
  const walk = (dir) => {
    let entries;
    try {
      entries = nodeFs.readdirSync(dir, { withFileTypes: true });
    } catch (_error) {
      return;
    }
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const full = nodePath.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.toml')) count += 1;
    }
  };
  walk(SUBMODULE_DIR);
  return count;
}

function main() {
  const checkOnly = process.argv.slice(2).includes('--check');

  if (!nodeFs.existsSync(SUBMODULE_DIR)) {
    console.error(
      `models.dev 子模块尚未检出: ${SUBMODULE_PATH}\n`
      + '先运行: git submodule update --init third_party/models.dev'
    );
    process.exit(1);
  }

  const branch = resolveTrackedBranch();
  const before = git(['rev-parse', 'HEAD']);
  git(['fetch', 'origin', branch]);
  const target = git(['rev-parse', `origin/${branch}`]);

  if (before === target) {
    console.log(`models.dev 已是最新 (${branch} @ ${before.slice(0, 9)})`);
    return;
  }

  const behind = git(['rev-list', '--count', `HEAD..origin/${branch}`]);
  const targetDate = git(['log', '-1', '--format=%ad', '--date=short', target]);
  const currentDate = git(['log', '-1', '--format=%ad', '--date=short', before]);

  if (checkOnly) {
    console.error(
      `models.dev 落后上游 ${behind} 个提交`
      + ` (本地 ${before.slice(0, 9)} ${currentDate}`
      + ` → 上游 ${target.slice(0, 9)} ${targetDate})\n`
      + '运行 npm run models:sync 同步。'
    );
    process.exit(1);
  }

  const filesBefore = countProviderFiles();
  git(['checkout', '--detach', target]);
  const filesAfter = countProviderFiles();

  console.log(
    `models.dev 已同步: ${before.slice(0, 9)} (${currentDate})`
    + ` → ${target.slice(0, 9)} (${targetDate})`
  );
  console.log(`  跨越提交数: ${behind}`);
  console.log(`  TOML 数据文件: ${filesBefore} → ${filesAfter}`);
  console.log('');
  console.log('子模块指针已变更但未提交，确认后执行:');
  console.log(`  git add ${SUBMODULE_PATH} && git commit`);
}

main();
