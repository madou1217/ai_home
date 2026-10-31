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

// `aih ss` / `aih sessions` 也走轻量路径：完整 CLI 组合根约 1.3s，而这两个命令
// 只需要持久会话列表 + 选择器。只在注册表里已经有会话时生效 —— 注册表为空时可能是
// 重启后需要 restore，那种情况交回完整 CLI（它会做懒恢复）。
function tryPersistentSessionFastPath() {
  const verb = process.argv[2];
  if (verb !== 'ss' && verb !== 'sessions') return false;
  const rest = process.argv.slice(3);
  if (rest.some((token) => token === '--help' || token === '-h' || token === 'help')) return false;
  try {
    const { resolveAiHomeDir } = require('../lib/runtime/aih-home');
    const aiHomeDir = resolveAiHomeDir({ env: process.env });
    if (!aiHomeDir) return false;
    const entries = require('../lib/runtime/persistent-session-registry').listEntries(aiHomeDir, {});
    if (!Array.isArray(entries) || entries.length === 0) return false;
    const { runGlobalPersistentSessionsCommand } = require('../lib/cli/services/ai-cli/persistent-session-list');
    const result = runGlobalPersistentSessionsCommand(rest, {
      aiHomeDir,
      processImpl: process,
      fs: require('node:fs'),
      consoleImpl: console
    });
    Promise.resolve(result).then(
      (code) => { process.exitCode = Number.isInteger(code) ? code : 0; },
      (error) => {
        process.stderr.write(`[aih] sessions failed: ${(error && error.message) || error}\n`);
        process.exitCode = 1;
      }
    );
    return true;
  } catch (_error) {
    return false;
  }
}

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
} else if (!tryPersistentSessionFastPath()) {
  require('../lib/cli/app');
}
