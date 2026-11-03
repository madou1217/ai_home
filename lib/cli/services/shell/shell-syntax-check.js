'use strict';

/**
 * 片段语法自检：把生成的片段交给**该 shell 自己的解析器**验一遍。
 *
 * 为什么必须有这一步：片段是写进用户 rc 的，语法错一次就是「打开终端就报错」。
 * 单元测试看不见这个（生成器只是拼字符串），只有真 shell 的 `-n` / PowerShell 的
 * Parser 才说得准。`aih shell doctor` 与 `apply` 都用它做前置检查。
 *
 * 每种 shell 的检查器：
 *   zsh / bash / fish   `<shell> -n <片段文件>`
 *   powershell          用 PowerShell 自己的 Parser 解析片段文件（先写一个极小 .ps1）
 */

const nodeFs = require('node:fs');
const nodeOs = require('node:os');
const nodePath = require('node:path');
const { spawnSync: nodeSpawnSync } = require('node:child_process');

const SYNTAX_CHECKERS = Object.freeze({
  zsh: Object.freeze({ binary: 'zsh', args: ['-n'] }),
  bash: Object.freeze({ binary: 'bash', args: ['-n'] }),
  fish: Object.freeze({ binary: 'fish', args: ['-n'] })
});

/** PowerShell 没有 `-n`：写一个小脚本用官方 Parser 解析目标文件并报告错误。 */
const POWERSHELL_PARSER_SCRIPT = [
  'param([string]$Path)',
  '$tokens = $null',
  '$errors = $null',
  '[void][System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tokens, [ref]$errors)',
  'if ($errors -and $errors.Count -gt 0) {',
  '    $errors | ForEach-Object { Write-Output ("{0}:{1}: {2}" -f $_.Extent.StartLineNumber, $_.Extent.StartColumnNumber, $_.Message) }',
  '    exit 1',
  '}',
  'exit 0',
  ''
].join('\n');

function runChecker(command, args, options = {}) {
  const spawnSync = options.spawnSync || nodeSpawnSync;
  try {
    const result = spawnSync(command, args, {
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true,
      env: options.env || process.env
    });
    const output = `${(result && result.stdout) || ''}${(result && result.stderr) || ''}`.trim();
    return { ok: (result && result.status) === 0, output, status: (result && result.status) ?? -1 };
  } catch (error) {
    return { ok: false, output: String((error && error.message) || error), status: -1 };
  }
}

/**
 * 检查片段语法。`binary` 由调用方给出（通常是 PATH 里找到的那个 shell）。
 * 返回 { ok, shell, checker, detail }；二进制找不到时 ok=true 且 `skipped: true`
 * （没装这个 shell 就无从检查，也不该因此判失败）。
 */
function checkShellSyntax(shell, snippet, options = {}) {
  const fsImpl = options.fs || nodeFs;
  const pathImpl = options.path || nodePath;
  const tmpDir = fsImpl.mkdtempSync(pathImpl.join(options.tmpdir || nodeOs.tmpdir(), 'aih-shell-check-'));
  const snippetFile = pathImpl.join(tmpDir, `snippet.${shell === 'powershell' ? 'ps1' : shell}`);
  try {
    fsImpl.writeFileSync(snippetFile, snippet, { mode: 0o600 });
    if (shell === 'powershell') {
      const parserFile = pathImpl.join(tmpDir, 'parse.ps1');
      fsImpl.writeFileSync(parserFile, POWERSHELL_PARSER_SCRIPT, { mode: 0o600 });
      const binary = options.binary || '';
      if (!binary) return { ok: true, shell, skipped: true, detail: 'powershell_not_found' };
      const result = runChecker(binary, ['-NoProfile', '-NoLogo', '-NonInteractive', '-File', parserFile, snippetFile], options);
      return { ok: result.ok, shell, checker: 'powershell-parser', detail: result.output };
    }
    const checker = SYNTAX_CHECKERS[shell];
    if (!checker) return { ok: true, shell, skipped: true, detail: 'unsupported_shell' };
    const binary = options.binary || '';
    if (!binary) return { ok: true, shell, skipped: true, detail: `${shell}_not_found` };
    const result = runChecker(binary, [...checker.args, snippetFile], options);
    return { ok: result.ok, shell, checker: `${checker.binary} -n`, detail: result.output };
  } catch (error) {
    return { ok: false, shell, checker: 'internal', detail: String((error && error.message) || error) };
  } finally {
    try {
      fsImpl.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_error) {
      /* 临时目录清不掉不影响结论 */
    }
  }
}

module.exports = {
  POWERSHELL_PARSER_SCRIPT,
  SYNTAX_CHECKERS,
  checkShellSyntax
};
