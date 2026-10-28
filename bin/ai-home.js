#!/usr/bin/env node

const { markAccountAppProcess } = require('../lib/runtime/account-app-process-marker');

markAccountAppProcess(process);

const SQLITE_EXPERIMENTAL_WARNING_RE = /SQLite is an experimental feature/i;
const originalEmitWarning = process.emitWarning.bind(process);

process.emitWarning = function patchedEmitWarning(warning, ...args) {
  const warningMessage = typeof warning === 'string'
    ? warning
    : String((warning && warning.message) || '');
  const warningType = typeof warning === 'string'
    ? String(args[0] || '')
    : String((warning && warning.name) || args[0] || '');

  if (warningType === 'ExperimentalWarning' && SQLITE_EXPERIMENTAL_WARNING_RE.test(warningMessage)) {
    return;
  }

  return originalEmitWarning(warning, ...args);
};

// 终端集成（TAB 补全 / 拼写建议）走**轻量路径**：完整 CLI 组合根要装配所有命令（实测约 1.3s），
// 而补全必须在一百毫秒内出结果。除这几个内部动词之外的一切照旧走 lib/cli/app。
const INTERNAL_FAST_PATH_VERBS = new Set(['__complete', '__suggest', '__learn']);

const fastPathVerb = process.argv[2];
if (INTERNAL_FAST_PATH_VERBS.has(fastPathVerb)) {
  const complete = require('../lib/cli/complete');
  const entryArgv = process.argv.slice(3);
  const exitCode = fastPathVerb === '__complete'
    ? complete.runCompleteEntry(entryArgv)
    : (fastPathVerb === '__suggest'
      ? complete.runSuggestEntry(entryArgv)
      : complete.runLearnEntry(entryArgv));
  process.exitCode = Number.isInteger(exitCode) ? exitCode : 0;
} else {
  require('../lib/cli/app');
}
