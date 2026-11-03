'use strict';

// `aih <cli> --model-alias` 的**启动整形**回归守卫（整条 CLI 进程级）。
//
// 规则要能到网关，启动器必须做两件事，缺一件就是「压根不生效」：
//   1. 把规则写进子进程的启动参数（codex 的 -c http_headers / claude 的 --settings）；
//   2. 附带 X-Aih-Route-Owner: node，让已划给 Go Core 的推理入口留在 Node
//      （Go 不认 x-aih-model-alias，转发过去会被摘掉）。
//
// 这里真的跑一遍 `aih <cli> exec …`：HOME 指向临时目录，PATH 最前面放一个只记录 argv 的
// 假 CLI。断言的是**真实启动参数**，而不是某个内部函数——之前正是在启动链路的接线处丢的
// （relay profile 拿到的是账号 env，而不是子进程最终的 env），单测全部通过但命令无效。

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const CLI = path.join(REPO_ROOT, 'bin', 'ai-home.js');

const POSIX_ONLY = process.platform !== 'win32'
  ? {}
  : { skip: 'POSIX shell shim: Windows 由 buildPtyLaunch 的 cmd.exe 包装，另行覆盖' };

function makeSandbox(provider) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-alias-launch-'));
  const binDir = path.join(home, '.local', 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const argvPath = path.join(home, `${provider}-argv.txt`);
  const binary = path.join(binDir, provider);
  fs.writeFileSync(binary, [
    '#!/bin/sh',
    `{ echo "=== invocation ==="; for a in "$@"; do printf '%s\\n' "$a"; done; } >> "${argvPath}"`,
    'exit 0',
    ''
  ].join('\n'), { mode: 0o755 });
  return {
    home,
    argvPath,
    cleanup: () => fs.rmSync(home, { recursive: true, force: true })
  };
}

function runCli(sandbox, argv) {
  return spawnSync(process.execPath, [CLI, ...argv], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: sandbox.home,
      USERPROFILE: sandbox.home,
      PATH: `${path.join(sandbox.home, '.local', 'bin')}${path.delimiter}/usr/bin${path.delimiter}/bin${path.delimiter}${process.env.PATH || ''}`
    },
    encoding: 'utf8',
    timeout: 120000
  });
}

function readArgv(sandbox) {
  return fs.existsSync(sandbox.argvPath) ? fs.readFileSync(sandbox.argvPath, 'utf8') : '';
}

test('codex：--model-alias 进 -c http_headers，并附带路由归属头', POSIX_ONLY, () => {
  const sandbox = makeSandbox('codex');
  try {
    const run = runCli(sandbox, [
      'codex', 'exec',
      '--model', 'gpt-6.1-sol',
      '-c', 'model_reasoning_effort="xhigh"',
      '--model-alias', 'gemini-3.8-flash-high',
      'hi'
    ]);
    const argv = readArgv(sandbox);
    assert.ok(argv, `假 codex 没被启动：${run.stdout}\n${run.stderr}`);
    assert.match(argv, /^model_providers\.aih_server\.http_headers\.X-Aih-Model-Alias=gpt-6\.1-sol=gemini-3\.8-flash-high$/m);
    // 推理入口已划给 Go Core：带规则时必须声明本请求由 Node 完整实现。
    assert.match(argv, /^model_providers\.aih_server\.http_headers\.X-Aih-Route-Owner=node$/m);
    // 用户自己的 -c 与 --model 照旧透传（修复不能靠吞参数换来）。
    assert.match(argv, /^model_reasoning_effort="xhigh"$/m);
    assert.match(argv, /^--model\n\/?$|^gpt-6\.1-sol$/m);
  } finally {
    sandbox.cleanup();
  }
});

test('claude：--model-alias 进 --settings 的 ANTHROPIC_CUSTOM_HEADERS', POSIX_ONLY, () => {
  const sandbox = makeSandbox('claude');
  try {
    const run = runCli(sandbox, [
      'claude',
      '--model', 'claude-x',
      '--model-alias', 'gemini-3.8-flash-high',
      'hi'
    ]);
    const argv = readArgv(sandbox);
    assert.ok(argv, `假 claude 没被启动：${run.stdout}\n${run.stderr}`);
    const settingsLine = argv.split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('==='));
    const settingsIndex = settingsLine.indexOf('--settings');
    assert.ok(settingsIndex >= 0, `启动参数里没有 --settings：\n${argv}`);
    const settingsPath = settingsLine[settingsIndex + 1];
    assert.ok(fs.existsSync(settingsPath), `--settings 指向的文件不存在：${settingsPath}`);
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const headers = String(settings.env && settings.env.ANTHROPIC_CUSTOM_HEADERS || '');
    assert.match(headers, /^x-aih-model-alias: claude-x=gemini-3\.8-flash-high$/m);
    assert.match(headers, /^X-Aih-Route-Owner: node$/m);
  } finally {
    sandbox.cleanup();
  }
});

test('codex：--model-alias 带 provider / 账号命名空间时原样送达网关', POSIX_ONLY, () => {
  const sandbox = makeSandbox('codex');
  try {
    const run = runCli(sandbox, [
      'codex', 'exec',
      '--model', 'gpt-6.1-sol',
      '--model-alias', 'kiro.2.glm-5',
      'hi'
    ]);
    const argv = readArgv(sandbox);
    assert.ok(argv, `假 codex 没被启动：${run.stdout}\n${run.stderr}`);
    // 命名空间必须完整到达网关：拆掉它就只能靠模型名猜 Provider（glm-* 会猜成 zcode）。
    assert.match(argv, /^model_providers\.aih_server\.http_headers\.X-Aih-Model-Alias=gpt-6\.1-sol=kiro\.2\.glm-5$/m);
  } finally {
    sandbox.cleanup();
  }
});
