'use strict';

const nodeFs = require('node:fs');
const { execFileSync: nodeExecFileSync } = require('node:child_process');
const { CLIENT_PLATFORMS } = require('../client-platform');
const {
  buildWindowsTerminalStartLine,
  pathEntryExists,
  resolveContext,
  resolveTerminalExecutable,
  tokenizeWindowsTerminalCommand
} = require('../client-terminal-support');
const {
  buildOfficialPowerShellPlans,
  powershellQuote,
  wingetOrOfficial
} = require('../client-terminal-lifecycle/windows');

const WINDOWS_TERMINAL_RELEASE_API = 'https://api.github.com/repos/microsoft/terminal/releases/latest';

// Windows Store 版的 wt.exe 是 AppExecutionAlias，Node/cmd 从后台会话启动它时
// 可能只激活已有宿主而丢掉 new-tab 参数。优先解析包内真正的
// WindowsTerminal.exe，保留完整命令行由 Windows Terminal 处理。
function resolvePackageExecutable(context) {
  const { fs, path } = context;
  // 注入的测试文件系统没有宿主 AppX 视图；没有显式进程探针时不触碰真实
  // PowerShell，避免跨平台测试被运行机器上已安装的 Windows Terminal 污染。
  if (context.platform !== CLIENT_PLATFORMS.WINDOWS) return '';
  if (fs !== nodeFs && !context.execFileSync) return '';
  const execFileSync = context.execFileSync || nodeExecFileSync;
  if (typeof execFileSync !== 'function') return '';
  try {
    const output = execFileSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "$ProgressPreference='SilentlyContinue'; (Get-AppxPackage -Name Microsoft.WindowsTerminal -ErrorAction SilentlyContinue | Select-Object -ExpandProperty InstallLocation)"
    ], { encoding: 'utf8', windowsHide: true });
    const lines = String(output || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    for (const line of lines) {
      const candidate = /[\\/]WindowsTerminal\.exe$/i.test(line)
        ? line
        : path.join(line, 'WindowsTerminal.exe');
      if (pathEntryExists(fs, candidate)) return candidate;
    }
  } catch (_error) {}
  return '';
}

function windowsInstallScript() {
  return [
    `$release = Invoke-RestMethod -Uri ${powershellQuote(WINDOWS_TERMINAL_RELEASE_API)} -Headers @{ Accept = 'application/vnd.github+json'; 'User-Agent' = 'ai-home-toolkit' }`,
    `$asset = $release.assets | Where-Object { $_.name -match '^Microsoft\\.WindowsTerminal_.+_8wekyb3d8bbwe\\.msixbundle$' } | Select-Object -First 1`,
    `if (-not $asset) { throw '未解析到 Windows Terminal 官方 MSIXBundle' }`,
    `$url = [string]$asset.browser_download_url`,
    `if (-not $url.StartsWith('https://github.com/microsoft/terminal/releases/download/')) { throw 'Windows Terminal 发布地址不可信' }`,
    `$bundle = Join-Path $env:TEMP ('aih-windows-terminal-' + [guid]::NewGuid().ToString('n') + '.msixbundle')`,
    `try {`,
    `  Invoke-WebRequest -Uri $url -OutFile $bundle -UseBasicParsing`,
    `  Add-AppxPackage -Path $bundle -ForceApplicationShutdown`,
    `} finally { Remove-Item -LiteralPath $bundle -Force -ErrorAction SilentlyContinue }`
  ].join('\n');
}

function windowsOfficialPlans(context = {}) {
  const install = windowsInstallScript();
  return buildOfficialPowerShellPlans('Windows Terminal', {
    install,
    update: install,
    uninstall: [
      `$packages = Get-AppxPackage -Name 'Microsoft.WindowsTerminal'`,
      `if (-not $packages) { exit 0 }`,
      `$packages | Remove-AppxPackage`
    ].join('\n')
  }, context);
}

const windowsTerminal = {
  id: 'windows-terminal',
  capability: 'toolkit.terminal',
  name: 'Windows Terminal',
  description: 'Windows 官方终端宿主，支持 PowerShell、CMD 与 WSL。',
  sourceUrl: 'https://learn.microsoft.com/en-us/windows/terminal/install',
  platforms: [CLIENT_PLATFORMS.WINDOWS],
  windowsOrder: 0,
  // Windows 上「默认终端」：已安装时由它承担 system-default 的启动与默认徽标。
  windowsDefaultWhenInstalled: true,
  executables: {
    windows: {
      binaryNames: ['wt.exe', 'wt'],
      paths: ['{hostHomeDir}/AppData/Local/Microsoft/WindowsApps/wt.exe']
    }
  },
  resolvePackageExecutable,
  detect(context) {
    const executablePath = resolveTerminalExecutable(windowsTerminal, context);
    return { installed: Boolean(executablePath), executablePath };
  },
  buildLaunch(command, title, context = {}) {
    const resolved = resolveContext(context);
    const executable = resolveTerminalExecutable(windowsTerminal, resolved);
    if (!executable) return null;
    const isResolvedPackageExecutable = /[\\/]WindowsApps[\\/].*[\\/]WindowsTerminal\.exe$/i.test(executable);
    if (isResolvedPackageExecutable) {
      // 已解析到 AppX 包内的真实宿主时直接传 argv。经过 cmd /c start 的命令字符串
      // 会再次被 Windows Terminal 的 positional parser 重组，可能把
      // `cmd.exe /k set` 合并成一个不存在的可执行文件并报 0x80070002。
      return {
        terminalId: windowsTerminal.id,
        file: executable,
        args: [
          '-w', 'new', 'new-tab', '--title', title,
          'cmd.exe', '/d', '/s', '/k',
          ...tokenizeWindowsTerminalCommand(command)
        ],
        windowsHide: false,
        terminalExecutable: executable
      };
    }
    // `-w new` 强制弹独立新窗口；裸 new-tab 会把标签塞进最近使用的既有窗口，
    // 目标窗口在别的虚拟桌面/最小化时用户表现为「点了没反应」。注意 1.24 实测
    // 不认 new-window 子命令（会被当成待运行程序名打开失败窗口）。
    // 外层 cmd 只负责执行 start，必须保持隐藏；start 创建的 WT 窗口不受
    // 外层 CREATE_NO_WINDOW 影响。直接 spawn AppExecutionAlias 在 Node 的
    // detached 链路中可能只激活 WT 宿主而不传递 new-tab 命令，因此这里保留
    // windowsVerbatimArguments，让 cmd 收到完整的 start 命令字符串。
    return {
      terminalId: windowsTerminal.id,
      file: 'cmd.exe',
      args: ['/d', '/s', '/c', buildWindowsTerminalStartLine(executable, title, command)],
      windowsHide: true,
      windowsVerbatimArguments: true,
      terminalExecutable: executable
    };
  },
  lifecycle: {
    windows: wingetOrOfficial({ packageId: 'Microsoft.WindowsTerminal', label: 'Windows Terminal' }, windowsOfficialPlans)
  }
};

module.exports = windowsTerminal;
