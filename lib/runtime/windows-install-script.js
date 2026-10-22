'use strict';

// Windows 安装脚本的共享片段。Desktop、CLI、工具链与终端安装共用同一套
// 下载/等待语义，避免出现「Desktop 修好了，工具安装还卡在旧写法」的半修状态。
//
// 两个真机事实（Windows 11 26220，PowerShell 5.1）：
// 1. Invoke-WebRequest 下载 216MB 安装包会停在 205.9MB 超过 15 分钟；
//    系统自带 curl.exe 下载同一文件 4 秒完成。
// 2. Start-Process -Wait 等待整棵进程树；Inno 安装器装完会拉起应用，
//    -Wait 会一直等到用户关闭应用（实测 15 分钟不返回）。

function powershellQuote(value) {
  return `'${String(value || '').replace(/'/g, "''")}'`;
}

// 生成「优先 curl.exe，缺失时回落 Invoke-WebRequest」两条语句。
// 调用方负责提前定义 $dest（或通过 dest 指定变量名）。
function buildWindowsDownloadStatements({ url = '', urlExpression = '', dest = '$dest', label = '安装包' } = {}) {
  const target = String(dest || '$dest');
  const source = urlExpression ? String(urlExpression) : powershellQuote(url);
  // if/else 必须是单条语句：`if (...) { ... }; else { ... }` 在 PowerShell 里
  // 会报 "else is not recognized"（真机实测），所以这里用 `} else {` 连接。
  const statement = `if ($curl) { & $curl.Source -fL --retry 3 --retry-delay 2 --connect-timeout 30 --speed-limit 1024 --speed-time 60 -o ${target} ${source}; if ($LASTEXITCODE -ne 0) { throw (${powershellQuote(label)} + '下载失败: curl 退出码 ' + $LASTEXITCODE) } } else { Invoke-WebRequest -Uri ${source} -OutFile ${target} -UseBasicParsing }`;
  return [
    '$curl = Get-Command curl.exe -ErrorAction SilentlyContinue',
    statement
  ].join('; ');
}

// 生成「静默启动 + 只等安装器自身进程 + 退出码校验 + UAC 明确报错」。
// 740 = 需要提权，1223 = 用户取消了 UAC；两者都要变成可读原因，不能假装成功。
function buildWindowsExecutableLaunchStatements({
  file = '$dest',
  silentArgs = [],
  timeoutMs = 20 * 60 * 1000,
  successExitCodes = [0, 3010]
} = {}) {
  const args = (Array.isArray(silentArgs) ? silentArgs : []).map((arg) => powershellQuote(arg)).join(', ');
  const launch = `$process = Start-Process -FilePath ${file}${args ? ` -ArgumentList @(${args})` : ''} -PassThru`;
  // try/catch 必须作为同一条语句拼接：`try { } ; catch { }` 不是合法 PowerShell。
  const guarded = `try { ${launch} } catch { $message = [string]$_.Exception.Message; $native = [int]$_.Exception.NativeErrorCode; if ($native -eq 740 -or $message -match 'elevation|提升|管理员权限|740') { throw ('安装器需要管理员权限，请允许 UAC 提示后重试: ' + $message) }; if ($native -eq 1223 -or $message -match 'canceled|cancelled|取消') { throw ('安装器需要管理员权限，但 UAC 授权被取消，请重试并允许授权: ' + $message) }; throw $_ }`;
  const accepted = (Array.isArray(successExitCodes) ? successExitCodes : [0])
    .map((code) => `$exitCode -ne ${Number(code)}`)
    .join(' -and ');
  const acceptedCheck = accepted || '$false';
  return `${guarded}; if (-not $process) { throw '安装器进程未能启动' }; if (-not $process.WaitForExit(${Number(timeoutMs) || 1200000})) { throw '安装器运行超时（20 分钟未退出）' }; $exitCode = [int]$process.ExitCode; if (${acceptedCheck}) { throw ('安装器退出码: ' + $exitCode) }`;
}

module.exports = {
  powershellQuote,
  buildWindowsDownloadStatements,
  buildWindowsExecutableLaunchStatements
};
