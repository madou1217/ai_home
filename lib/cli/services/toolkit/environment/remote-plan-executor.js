'use strict';

// 远端计划执行器：把 toolkit 生命周期计划（argv 形式：command + args）放到远端机器执行。
// 与本机 executeLifecyclePlan 同一返回形状 {ok, error, exitCode, stdout, stderr, outputTruncated, timedOut?}，
// 作业管理器（environment-tool-job-manager）不区分本机 / 远端。
//
// - POSIX：argv 逐个 sh 引用后拼成一行，放进用户的登录 shell 执行（拿到 ~/.local/bin 等用户级 PATH）；
// - Windows：PowerShell `& 'cmd' 'arg' ...`，经 -EncodedCommand 传入，不受默认 shell（cmd / pwsh）引号规则影响；
// - 计划里的 env 以导出语句前置（只导出计划声明的变量，本机环境变量不会带过去）；
// - 安装是长任务：走 bulk 车道的一次性 exec 通道，输出边跑边回传。

const { POSIX, psQuote, psScript, shQuote } = require('../../../../remote-workspace/ops/dialect');

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function posixScript(plan) {
  const exports = Object.entries(plan.env || {})
    .filter(([name]) => ENV_NAME.test(name))
    .map(([name, value]) => `export ${name}=${shQuote(value)}; `)
    .join('');
  const cd = plan.cwd ? `cd ${shQuote(plan.cwd)} && ` : 'cd "$HOME" && ';
  const line = [plan.command, ...(plan.args || [])].map(shQuote).join(' ');
  return POSIX.loginShell(`${POSIX.userToolPath()}; ${exports}${cd}${line}`);
}

function windowsScript(plan) {
  const exports = Object.entries(plan.env || {})
    .filter(([name]) => ENV_NAME.test(name))
    .map(([name, value]) => `$env:${name}=${psQuote(value)}; `)
    .join('');
  const cd = plan.cwd ? `Set-Location -LiteralPath ${psQuote(plan.cwd)}; ` : 'Set-Location -LiteralPath $HOME; ';
  const line = `& ${[plan.command, ...(plan.args || [])].map(psQuote).join(' ')}`;
  return psScript(`$ProgressPreference='SilentlyContinue'; ${exports}${cd}${line}; exit $LASTEXITCODE`);
}

/** → {command, stdin?}：Windows 的长脚本经 stdin 传入（见 dialect.psScript）。 */
function buildRemotePlanCommand(plan, platform) {
  return platform === 'windows' ? windowsScript(plan) : { command: posixScript(plan) };
}

/**
 * @param {object} plan normalizePlan 的结果
 * @param {{machine, platform, onOutput?, errorPrefix?, maxOutputBytes?}} options
 */
async function executeRemotePlan(plan, options = {}) {
  const prefix = String(options.errorPrefix || 'environment_action');
  const timeoutMs = Math.min(Math.max(Number(plan && plan.timeoutMs) || DEFAULT_TIMEOUT_MS, 1000), 60 * 60 * 1000);
  const maxOutputBytes = Math.min(Math.max(Number(options.maxOutputBytes) || 64 * 1024, 1024), 1024 * 1024);
  try {
    const { command, stdin } = buildRemotePlanCommand(plan, options.platform);
    const result = await options.machine.exec(command, {
      stdin,
      lane: 'bulk',
      timeoutMs,
      maxOutputBytes,
      onOutput: options.onOutput
    });
    // 失败时把远端输出的最后几行带上（任务队列只显示 message），否则用户只能看到「失败」。
    const tail = (result.stderr || result.stdout).trim().split(/\r?\n/).slice(-4).join(' / ').slice(0, 400);
    return {
      ok: result.code === 0,
      error: result.code === 0 ? null : `${prefix}_failed`,
      message: result.code === 0 ? undefined : `远端命令退出码 ${result.code}${tail ? `：${tail}` : ''}`,
      exitCode: Number.isInteger(result.code) ? result.code : null,
      signal: null,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
      outputTruncated: result.truncated
    };
  } catch (error) {
    const code = String(error && error.code || '');
    return {
      ok: false,
      error: code === 'operation_timeout' ? `${prefix}_timeout` : `${prefix}_spawn_failed`,
      timedOut: code === 'operation_timeout',
      message: String(error && error.message || error),
      stdout: '',
      stderr: '',
      outputTruncated: false
    };
  }
}

module.exports = { buildRemotePlanCommand, executeRemotePlan };
