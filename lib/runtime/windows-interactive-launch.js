'use strict';

const nodeFs = require('node:fs');
const nodeOs = require('node:os');
const nodePath = require('node:path');
const { execFileSync: nodeExecFileSync } = require('node:child_process');

const TASK_PREFIX = 'AihWebCli';
const FILE_PREFIX = 'aih-web-cli';

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

function assertBatchText(value, label) {
  const text = String(value == null ? '' : value);
  if (/[\r\n]/.test(text)) throw new TypeError(`${label} must not contain newlines`);
  return text;
}

// Batch files use a quoted assignment (`set "KEY=value"`) so &, | and spaces
// stay data. Percent signs are doubled because this text is written to a .cmd
// file rather than passed through Node/libuv.
function quoteBatchValue(value) {
  return assertBatchText(value, 'batch value')
    .replace(/%/g, '%%')
    .replace(/"/g, '""');
}

function quoteBatchPath(value) {
  const text = assertBatchText(value, 'batch path');
  if (!text) throw new TypeError('batch path is required');
  return `"${text.replace(/%/g, '%%').replace(/"/g, '""')}"`;
}

function normalizeTitle(value) {
  return assertBatchText(value || 'AI Home CLI', 'title')
    .replace(/"/g, "'")
    .replace(/[&|<>^]/g, ' ')
    .trim() || 'AI Home CLI';
}

function createNonce(options = {}) {
  const injected = normalizeText(options.nonce);
  if (injected) return injected.replace(/[^A-Za-z0-9_-]/g, '-');
  const processObj = options.processObj || process;
  const random = Math.random().toString(16).slice(2, 10);
  return `${processObj.pid || '0'}-${Date.now()}-${random}`;
}

function buildInteractiveCommandScript(command, options = {}) {
  const commandText = assertBatchText(command, 'command').trim();
  if (!commandText) throw new TypeError('command is required');
  const environment = options.environment && typeof options.environment === 'object'
    ? options.environment
    : {};
  const assignments = Object.entries(environment)
    .map(([key, value]) => {
      const name = assertBatchText(key, 'environment key').trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new TypeError(`invalid environment key: ${name}`);
      return `set "${name}=${quoteBatchValue(value)}"`;
    });
  const lines = ['@echo off', ...assignments, commandText, 'set "AIH_WEB_CLI_EXIT=%ERRORLEVEL%"', 'del "%~f0" >nul 2>&1', 'exit /b %AIH_WEB_CLI_EXIT%'];
  return `${lines.join('\r\n')}\r\n`;
}

function buildInteractiveBootstrapScript(options = {}) {
  const title = normalizeTitle(options.title);
  const runPath = quoteBatchPath(options.runPath);
  const lines = [
    '@echo off',
    `start "${title}" cmd.exe /d /s /k call ${runPath}`,
    'del "%~f0" >nul 2>&1',
    'exit /b 0'
  ];
  return `${lines.join('\r\n')}\r\n`;
}

function resolveTaskUser(env, execFileSyncImpl) {
  const source = env && typeof env === 'object' ? env : {};
  // schtasks 在本机账户上不接受某些 `WORKGROUP\\user` 形式；USERNAME 是
  // 当前交互会话可直接使用的主体名，优先保留它。只有环境没有用户名时，
  // 才回退到 whoami 返回的域名/主体格式。
  const direct = normalizeText(source.USERNAME || source.USER || source.UserName);
  if (direct) return direct;
  if (typeof execFileSyncImpl === 'function') {
    try {
      const whoami = normalizeText(execFileSyncImpl('whoami', [], { encoding: 'utf8', windowsHide: true }));
      if (whoami) return whoami.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';
    } catch (_error) {}
  }
  return '';
}

function cleanupLaunchFiles(fsImpl, paths) {
  for (const filePath of paths) {
    try { fsImpl.unlinkSync(filePath); } catch (_error) {}
  }
}

function launchWindowsInteractiveCommand(command, options = {}) {
  const processObj = options.processObj || process;
  if (String(processObj.platform || process.platform) !== 'win32') {
    return { ok: false, error: 'unsupported_platform' };
  }
  const fsImpl = options.fs || nodeFs;
  const osImpl = options.os || nodeOs;
  const pathImpl = options.path || nodePath.win32;
  const execFileSyncImpl = options.execFileSync || nodeExecFileSync;
  const env = options.env || processObj.env || {};
  const tempDir = normalizeText(options.tempDir || (typeof osImpl.tmpdir === 'function' ? osImpl.tmpdir() : ''));
  if (!tempDir) return { ok: false, error: 'interactive_temp_unavailable' };
  const user = resolveTaskUser(env, execFileSyncImpl);
  if (!user) return { ok: false, error: 'interactive_user_unavailable' };

  const nonce = createNonce({ ...options, processObj });
  const taskName = `${TASK_PREFIX}_${nonce}`.slice(0, 180);
  const runPath = pathImpl.join(tempDir, `${FILE_PREFIX}-${nonce}.cmd`);
  const bootstrapPath = pathImpl.join(tempDir, `${FILE_PREFIX}-${nonce}-bootstrap.cmd`);
  const environment = {
    AIH_HOME: options.aiHomeDir,
    AIH_HOST_HOME: options.hostHomeDir,
    PATH: env.PATH || env.Path || env.path
  };
  Object.keys(environment).forEach((key) => {
    if (!normalizeText(environment[key])) delete environment[key];
  });

  try {
    fsImpl.writeFileSync(runPath, buildInteractiveCommandScript(command, { environment }), { encoding: 'ascii', mode: 0o600 });
    fsImpl.writeFileSync(bootstrapPath, buildInteractiveBootstrapScript({
      title: options.title,
      runPath
    }), { encoding: 'ascii', mode: 0o600 });
    const taskCommand = `cmd.exe /d /s /c ${quoteBatchPath(bootstrapPath)}`;
    execFileSyncImpl('schtasks.exe', [
      '/Create', '/TN', taskName, '/SC', 'ONCE', '/ST', '00:00',
      '/RU', user, '/IT', '/TR', taskCommand, '/F'
    ], { encoding: 'utf8', windowsHide: true, stdio: 'ignore' });
    execFileSyncImpl('schtasks.exe', ['/Run', '/TN', taskName], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: 'ignore'
    });
    // /Run 只提交任务，不会阻止其已排队的交互进程；由发起方立即删除
    // 一次性任务，避免任务自删竞态和残留。已启动的 cmd/Codex 子进程继续运行。
    let cleanupWarning = '';
    try {
      execFileSyncImpl('schtasks.exe', ['/Delete', '/TN', taskName, '/F'], {
        encoding: 'utf8',
        windowsHide: true,
        stdio: 'ignore'
      });
    } catch (error) {
      cleanupWarning = String((error && error.message) || error || 'scheduled task cleanup failed');
    }
    return {
      ok: true,
      taskName,
      runPath,
      bootstrapPath,
      user,
      ...(cleanupWarning ? { cleanupWarning } : {})
    };
  } catch (error) {
    try { execFileSyncImpl('schtasks.exe', ['/Delete', '/TN', taskName, '/F'], { stdio: 'ignore', windowsHide: true }); } catch (_error) {}
    cleanupLaunchFiles(fsImpl, [runPath, bootstrapPath]);
    return {
      ok: false,
      error: 'interactive_launch_failed',
      message: String((error && error.message) || error || 'schtasks launch failed')
    };
  }
}

module.exports = {
  buildInteractiveCommandScript,
  buildInteractiveBootstrapScript,
  resolveTaskUser,
  launchWindowsInteractiveCommand
};
