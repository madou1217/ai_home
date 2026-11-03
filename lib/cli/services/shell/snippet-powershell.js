'use strict';

/**
 * PowerShell 侧终端集成片段（`aih shell apply` 写进 `$PROFILE` 的受管块）。
 *
 * 与 zsh/bash/fish 版语义一致，用 PowerShell 自己的机制：
 * - 补全：`Register-ArgumentCompleter -Native`（PS 5.1+ / 7.x 都支持），
 *   把命令行元素交给 `aih __complete --shell powershell`，返回 `CompletionResult`（带 ToolTip）。
 * - 打错：PSReadLine 的 `-CommandValidationHandler`（按下回车时校验），
 *   命令不存在时列候选、确认后运行；`e` 用 `PSConsoleReadLine::Replace` 把纠正写回命令行。
 * - `aih` 自身的错字：同名函数包一层，只在退出码 2 时接话。
 *
 * 纪律：整段包在 `try/catch` 里，任何一步失败都只让集成静默降级，绝不弄坏用户 profile。
 */

function psQuote(value) {
  return `'${String(value == null ? '' : value).replace(/'/g, "''")}'`;
}

function buildPowerShellSnippet(options = {}) {
  const aihBinPath = String(options.aihBinPath || 'aih');
  const completion = options.completion !== false;
  const typo = options.typo !== false;
  const wrapper = options.wrapper !== false;
  const historyTail = Math.max(200, Number(options.historyTail) || 1000);
  const lines = [];
  lines.push('# aih 终端集成：TAB 补全 + 命令打错时的纠正建议。');
  lines.push('# 由 `aih shell apply` 生成，请勿手改；调整用 `aih shell apply <选项>`，移除用 `aih shell remove`。');
  lines.push(`$global:AIH_SHELL_BIN = ${psQuote(aihBinPath)}`);
  lines.push(`$global:AIH_SHELL_TYPO = ${typo ? '$true' : '$false'}`);
  lines.push(`$global:AIH_SHELL_WRAPPER = ${wrapper ? '$true' : '$false'}`);
  lines.push(`$global:AIH_SHELL_HISTORY_TAIL = ${historyTail}`);
  lines.push(`$global:_AIH_SHELL_US = [char]0x1f`);
  lines.push('');
  lines.push('function global:Get-AihShellReady {');
  lines.push('    if ($global:AIH_SHELL_BIN -and (Test-Path -LiteralPath $global:AIH_SHELL_BIN)) { return $true }');
  lines.push('    $found = Get-Command aih -ErrorAction SilentlyContinue');
  lines.push('    if (-not $found) { return $false }');
  lines.push('    $global:AIH_SHELL_BIN = $found.Source');
  lines.push('    return [bool]$global:AIH_SHELL_BIN');
  lines.push('}');
  lines.push('');
  lines.push('function global:Get-AihShellHistory {');
  lines.push('    $items = @(Get-History | Select-Object -Last $global:AIH_SHELL_HISTORY_TAIL | ForEach-Object { $_.CommandLine })');
  lines.push('    return $items');
  lines.push('}');
  lines.push('');
  lines.push('function global:Get-AihShellReasonLabel {');
  lines.push('    param([string]$Reason)');
  lines.push('    switch ($Reason) {');
  lines.push("        'learned' { '你确认过' }");
  lines.push("        'case' { '大小写' }");
  lines.push("        'transposition' { '两个字母写反了' }");
  lines.push("        'typo' { '打错字符' }");
  lines.push("        'abbrev' { '少写了字母' }");
  lines.push("        'prefix' { '前缀匹配' }");
  lines.push("        'history' { '历史里用过' }");
  lines.push("        default { '拼写接近' }");
  lines.push('    }');
  lines.push('}');
  lines.push('');
  lines.push('# 调一次 aih 的轻量入口；返回原始输出行（不抛出）。');
  lines.push('function global:Invoke-AihShellTool {');
  lines.push('    param([string[]]$ToolArgs, [string[]]$HistoryLines)');
  lines.push('    try {');
  lines.push('        if (-not (Get-AihShellReady)) { return @() }');
  lines.push('        $historyText = ($HistoryLines -join "`n")');
  lines.push('        $out = $historyText | & $global:AIH_SHELL_BIN @ToolArgs 2>$null');
  lines.push('        return @($out)');
  lines.push('    } catch { return @() }');
  lines.push('}');
  lines.push('');
  if (completion) lines.push(...buildPowerShellCompletion());
  if (typo) {
    lines.push(...buildPowerShellTypoHandler());
    lines.push(...buildPowerShellEnterHandler());
  }
  if (wrapper) lines.push(...buildPowerShellWrapper());
  return `${lines.join('\n')}\n`;
}

function buildPowerShellCompletion() {
  return [
    '# ---- TAB 补全 ----',
    'Register-ArgumentCompleter -Native -CommandName aih -ScriptBlock {',
    '    param($wordToComplete, $commandAst, $cursorPosition)',
    '    if (-not (Get-AihShellReady)) { return }',
    '    try {',
    '        $elements = @($commandAst.CommandElements | ForEach-Object { $_.Extent.Text })',
    '        $all = @()',
    '        if ($elements.Count -gt 1) { $all = @($elements[1..($elements.Count - 1)]) }',
    '        $prior = @()',
    '        if ($all.Count -ge 1 -and $all[-1] -eq $wordToComplete) {',
    '            if ($all.Count -ge 2) { $prior = @($all[0..($all.Count - 2)]) }',
    '        } else {',
    '            $prior = $all',
    '        }',
    '        $toolArgs = @("__complete", "--shell", "powershell", "--history-stdin", "--current=$wordToComplete", "--") + $prior',
    '        $lines = Invoke-AihShellTool -ToolArgs $toolArgs -HistoryLines (Get-AihShellHistory)',
    '        foreach ($line in $lines) {',
    '            if (-not $line) { continue }',
    '            $parts = $line -split [string]$global:_AIH_SHELL_US',
    '            $value = $parts[0]',
    '            $desc = ""',
    '            if ($parts.Count -ge 2) { $desc = $parts[1] }',
    '            [System.Management.Automation.CompletionResult]::new($value, $value, "ParameterValue", $desc)',
    '        }',
    '    } catch { }',
    '}',
    ''
  ];
}

function buildPowerShellTypoHandler() {
  return [
    '# ---- 命令打错时的纠正建议（PSReadLine 回车钩子）----',
    '# 取证结论：PSReadLine 的 -CommandValidationHandler 对「命令不存在」根本不会被调用',
    '# （BasicEditing.cs 里的内建 CommandNotFound 检查先短路返回），所以只能接管 Enter 键：',
    '# 先判一次「这个命令存在吗」，不存在才列候选；其余情况原样调用 AcceptLine()。',
    'function global:Show-AihShellTypoSuggestions {',
    '    param([string]$Message, [string]$Head, [string[]]$ToolArgs)',
    '    $lines = Invoke-AihShellTool -ToolArgs $ToolArgs -HistoryLines (Get-AihShellHistory)',
    '    if ($lines.Count -eq 0) { return $null }',
    '    $kind = ($lines[0] -split [string]$global:_AIH_SHELL_US)',
    '    if ($kind.Count -lt 2 -or $kind[1] -eq "none") { return $null }',
    '    $typoKey = $Head',
    '    if ($kind.Count -ge 3 -and $kind[2]) { $typoKey = $kind[2] }',
    '    $candidates = @()',
    '    foreach ($line in $lines[1..($lines.Count - 1)]) {',
    '        $parts = $line -split [string]$global:_AIH_SHELL_US',
    '        if ($parts.Count -lt 4 -or $parts[0] -ne "aih:cand") { continue }',
    '        $candidates += [pscustomobject]@{',
    '            Display = $parts[1]',
    '            Reason = (Get-AihShellReasonLabel $parts[2])',
    '            Argv = @($parts[3] -split [string]$global:_AIH_SHELL_US)',
    '        }',
    '    }',
    '    if ($candidates.Count -eq 0) { return $null }',
    '    Write-Host ""',
    '    Write-Host "[aih] $Message，你是不是想运行：" -ForegroundColor Yellow',
    '    for ($i = 0; $i -lt $candidates.Count; $i++) {',
    '        Write-Host ("  {0}) {1}  ({2})" -f ($i + 1), $candidates[$i].Display, $candidates[$i].Reason) -ForegroundColor DarkGray',
    '    }',
    '    $answer = Read-Host ("选择序号运行 [1-{0}]（回车=取消，e=放到命令行自己编辑）" -f $candidates.Count)',
    '    if (-not $answer) { return $null }',
    '    if ($answer -eq "e" -or $answer -eq "E") { return $candidates[0].Display }',
    '    if ($answer -notmatch "^\\d+$") { return $null }',
    '    $index = [int]$answer',
    '    if ($index -lt 1 -or $index -gt $candidates.Count) { return $null }',
    '    $chosen = $candidates[$index - 1]',
    '    & $global:AIH_SHELL_BIN __learn $typoKey -- @($chosen.Argv) 2>$null | Out-Null',
    '    Write-Host ("[aih] 运行：{0}" -f $chosen.Display) -ForegroundColor DarkGray',
    '    if ($chosen.Argv.Count -gt 1) { & $chosen.Argv[0] @($chosen.Argv[1..($chosen.Argv.Count - 1)]) } else { & $chosen.Argv[0] }',
    '    return ""',
    '}',
    ''
  ];
}

function buildPowerShellEnterHandler() {
  return [
    'function global:Set-AihShellEnterHandler {',
    '    if (-not (Get-Command Set-PSReadLineKeyHandler -ErrorAction SilentlyContinue)) { return }',
    '    if (-not $global:AIH_SHELL_TYPO) { return }',
    '    try {',
    '        Set-PSReadLineKeyHandler -Key Enter -ScriptBlock {',
    '            param($key, $arg)',
    '            try {',
    '                $line = ""',
    '                $cursor = 0',
    '                [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$line, [ref]$cursor)',
    '                if ($global:AIH_SHELL_TYPO -and $line -and $line.Trim() -and $line.Length -lt 500 -and (Get-AihShellReady)) {',
    '                    $trimmed = $line.Trim()',
    '                    $name = ($trimmed -split "\\s+")[0]',
    '                    if ($name -match "^[A-Za-z0-9_\\-]+$" -and -not (Get-Command $name -ErrorAction SilentlyContinue)) {',
    '                        $tokens = $trimmed -split "\\s+"',
    '                        $rest = @()',
    '                        if ($tokens.Count -gt 1) { $rest = @($tokens[1..($tokens.Count - 1)]) }',
    '                        $toolArgs = @("__suggest", "--history-stdin", "--") + @($name) + $rest',
    '                        $corrected = Show-AihShellTypoSuggestions -Message "没有 $name 这个命令" -Head $name -ToolArgs $toolArgs',
    '                        if ($null -ne $corrected) {',
    '                            if ($corrected) {',
    '                                [Microsoft.PowerShell.PSConsoleReadLine]::Replace(0, $line.Length, $corrected)',
    '                            } else {',
    '                                [Microsoft.PowerShell.PSConsoleReadLine]::Replace(0, $line.Length, "")',
    '                            }',
    '                            return',
    '                        }',
    '                    }',
    '                }',
    '            } catch { }',
    '            [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine()',
    '        }',
    '    } catch { }',
    '}',
    ''
  ];
}

function buildPowerShellWrapper() {
  return [
    '# ---- aih 自身命令打错（如 ahi / aih codx）----',
    'function global:aih {',
    '    & $global:AIH_SHELL_BIN @args',
    '    $rc = $LASTEXITCODE',
    '    $interactive = -not [Console]::IsInputRedirected -and -not [Console]::IsOutputRedirected',
    '    if ($rc -eq 2 -and $global:AIH_SHELL_WRAPPER -and $interactive) {',
    '        try {',
    '            $toolArgs = @("__suggest", "--inside", "--history-stdin", "--", "aih") + @($args)',
    '            $head = "aih"',
    '            if ($args.Count -ge 1) { $head = $args[0] }',
    '            $corrected = Show-AihShellTypoSuggestions -Message "aih 不认识 $head" -Head $head -ToolArgs $toolArgs',
    '            if ($corrected) {',
    '                $line = ""',
    '                $cursor = 0',
    '                [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$line, [ref]$cursor)',
    '                [Microsoft.PowerShell.PSConsoleReadLine]::Replace(0, $line.Length, $corrected)',
    '            }',
    '        } catch { }',
    '    }',
    '    $global:LASTEXITCODE = $rc',
    '}',
    '',
    'try { Set-AihShellEnterHandler } catch { }',
    ''
  ];
}

module.exports = {
  buildPowerShellCompletion,
  buildPowerShellEnterHandler,
  buildPowerShellSnippet,
  buildPowerShellTypoHandler,
  buildPowerShellWrapper,
  psQuote
};
