'use strict';

/**
 * 补全覆盖审计：把所有顶层命令（以及声明过的子命令层）过一遍，列出哪些位置**一个候选
 * 都没有**，并按"设计上就该空"的名单区分开。
 *
 * 用法：
 *   node scripts/audit-cli-completion.js          # 表格 + 结论
 *   node scripts/audit-cli-completion.js --json
 *
 * 退出码：0 = 没有意外空位；1 = 有命令能敲到却没有候选（需要补声明或补数据源）。
 */

const { resolveCompletion } = require('../lib/cli/complete/resolve');
const { TOP_LEVEL_COMMANDS, NESTED_SUBCOMMAND_TABLES } = require('../lib/cli/complete/command-tree');

// 设计上不给候选的位置：
//   export/import  文件路径交给 shell
//   ssh            后面是 ssh 自己的参数
//   resume         依赖真实会话库（审计里没有数据源，实际一定有）
//   help           后面接命令名，交给 shell 的历史/默认
const INTENTIONAL_EMPTY = new Set(['export', 'import', 'ssh', 'resume', 'help']);

const context = {
  listAccounts: () => [],
  listSessions: () => [],
  listResumeSessions: () => [],
  historyEntries: []
};

function audit() {
  const rows = [];
  for (const command of TOP_LEVEL_COMMANDS) {
    const items = resolveCompletion([command.name, ''], context);
    rows.push({ position: command.name, candidates: items.length, empty: items.length === 0 });
  }
  for (const key of Object.keys(NESTED_SUBCOMMAND_TABLES)) {
    const words = [...key.split(' '), ''];
    const items = resolveCompletion(words, context);
    rows.push({ position: words.slice(0, -1).join(' '), candidates: items.length, empty: items.length === 0 });
  }
  const unexpected = rows.filter((row) => row.empty && !INTENTIONAL_EMPTY.has(row.position));
  return { rows, unexpected };
}

function main() {
  const { rows, unexpected } = audit();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ rows, unexpected }, null, 2));
  } else {
    for (const row of rows) {
      console.log(`${row.position.padEnd(28)} ${String(row.candidates).padStart(3)}`);
    }
    console.log('');
    if (unexpected.length === 0) {
      console.log('OK：没有"能敲到却没有候选"的位置（导出/导入/ssh/resume 属于设计上交给 shell 或依赖数据源）。');
    } else {
      console.log(`需要补的位置：${unexpected.map((row) => row.position).join(', ')}`);
    }
  }
  process.exitCode = unexpected.length === 0 ? 0 : 1;
}

if (require.main === module) main();

module.exports = { INTENTIONAL_EMPTY, audit };
