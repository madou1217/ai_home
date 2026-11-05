'use strict';

// headless runner 的**子进程垫片**：把「走注册的 headless runner（如 zcode 的 app-server
// 通道）」表达成一次普通子进程 —— stdout/stderr/exitCode 语义与 native CLI 逐字节一致，
// 于是 headless-spawn 的 handle、缓冲、回灌、退出码转发一行都不用改。
//
// 规格（provider + 已装配环境 + 启动规格）由父进程写进 0600 临时文件，argv 只收路径
// （环境变量会进 `ps`，规格里有账号引用与数据根）。
//
// 用法：node headless-runner-trampoline.js <spec.json>

// 垫片是独立 Node 进程：runner 会读账号库/会话库（node:sqlite），首次使用会打
// ExperimentalWarning。它是我们的脚手架进程，警告纯属脏数据（会混进 `-p` 的输出），
// 在 require 任何业务模块之前装过滤。
require('../../../runtime/sqlite-warning-filter').installSqliteWarningFilter(process);

const fs = require('node:fs');

const { resolveHeadlessRunner } = require('../ai-cli/launch-profile');

function readSpec(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_error) {
    return null;
  }
}

async function main() {
  const specPath = String(process.argv[2] || '').trim();
  const spec = specPath ? readSpec(specPath) : null;
  if (!spec) {
    process.stderr.write('headless runner 规格不可读\n');
    process.exit(1);
    return;
  }
  const runner = resolveHeadlessRunner(spec.provider);
  if (!runner) {
    process.stderr.write(`provider ${spec.provider} 没有注册 headless runner\n`);
    process.exit(1);
    return;
  }
  const result = await runner.run({
    launch: spec.launch,
    env: spec.env,
    args: Array.isArray(spec.args) ? spec.args : [],
    deps: {
      ...(spec.deps || {}),
      onData: (text) => process.stdout.write(String(text || '')),
      onErrorData: (text) => process.stderr.write(String(text || ''))
    }
  });
  process.exit(result && Number.isFinite(result.exitCode) ? result.exitCode : 0);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`headless runner 垫片失败：${String((error && error.message) || error)}\n`);
    process.exit(1);
  });
}

module.exports = { main };
