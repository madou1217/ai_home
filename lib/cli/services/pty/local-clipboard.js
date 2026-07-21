'use strict';

// Local (Windows / WSL) clipboard integration for interactive PTY sessions:
// Alt+V image-paste capture through PowerShell, wslpath normalization, and
// the optional background clipboard-mirror poller (cross-instance singleton
// via a pid lock file). The SSH-side clipboard lives in
// ssh-clipboard-bridge.js; this module is its local counterpart.
// Extracted from runCliPty; exported names match the original closure
// functions so call sites are unchanged.

const {
  isAltVClipboardTrigger,
  isEmptyBracketedPaste
} = require('../ssh-clipboard/keys');
const { resolveAihRunPath } = require('../../../runtime/aih-storage-layout');

function createLocalClipboard(deps = {}) {
  const {
    fs,
    path,
    processObj,
    spawn,
    execSync,
    aiHomeDir,
    isLogin,
    isSshRuntimeSession,
    isInteractiveSession,
    isCleanedUp
  } = deps;

  let clipboardMirrorProc = null;
  let clipboardMirrorRestartTimer = null;
  let clipboardMirrorLockPath = '';
  let clipboardMirrorLockOwned = false;

  function isWslPlatform() {
    if (processObj.platform !== 'linux') return false;
    return Boolean(processObj.env.WSL_DISTRO_NAME || processObj.env.WSL_INTEROP);
  }

  function canBridgeWindowsClipboard() {
    return processObj.platform === 'win32' || isWslPlatform();
  }

  function shellSingleQuote(value) {
    return `'${String(value || '').replace(/'/g, '\'\"\'\"\'')}'`;
  }

  function isClipboardPasteTrigger(data) {
    if (!canBridgeWindowsClipboard() && !isSshRuntimeSession()) return false;
    if (isAltVClipboardTrigger(data)) return true;
    return isSshRuntimeSession() && isEmptyBracketedPaste(data);
  }

  function normalizeClipboardImagePath(capturedPath) {
    const trimmed = String(capturedPath || '').trim();
    if (!trimmed) return '';
    if (!isWslPlatform()) return trimmed;
    try {
      const converted = execSync(`wslpath -u ${shellSingleQuote(trimmed)}`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      });
      return String(converted || '').trim() || trimmed;
    } catch (_error) {
      return trimmed;
    }
  }

  function tryCaptureClipboardImagePathOnWindows() {
    if (!canBridgeWindowsClipboard()) return '';
    if (String(processObj.env.AIH_WINDOWS_IMAGE_PASTE || '1') === '0') return '';
    const psScript = [
      "$ErrorActionPreference = 'Stop'",
      'Add-Type -AssemblyName System.Windows.Forms',
      'Add-Type -AssemblyName System.Drawing',
      'if (-not [System.Windows.Forms.Clipboard]::ContainsImage()) { exit 3 }',
      '$img = [System.Windows.Forms.Clipboard]::GetImage()',
      'if ($null -eq $img) { exit 4 }',
      '$dir = Join-Path $env:TEMP "aih-image-paste"',
      '[System.IO.Directory]::CreateDirectory($dir) | Out-Null',
      '$cutoff = [DateTime]::UtcNow.AddDays(-1)',
      'Get-ChildItem -LiteralPath $dir -File -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTimeUtc -lt $cutoff } | ForEach-Object { try { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue } catch {} }',
      '$file = Join-Path $dir ("aih_clip_" + [DateTime]::Now.ToString("yyyyMMdd_HHmmss_fff") + ".png")',
      '$img.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)',
      '[System.Windows.Forms.Clipboard]::SetText($file)',
      'Write-Output $file'
    ].join('; ');

    const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
    const powerShellCandidates = isWslPlatform()
      ? ['powershell.exe', 'powershell']
      : ['powershell.exe', 'powershell', 'pwsh.exe', 'pwsh'];
    for (const psCmd of powerShellCandidates) {
      try {
        const stdout = execSync(`${psCmd} -NoProfile -STA -EncodedCommand ${encoded}`, {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore']
        });
        const normalized = normalizeClipboardImagePath(stdout);
        if (normalized) return normalized;
      } catch (_error) {}
    }
    return '';
  }

  function stopClipboardMirrorProcess() {
    if (clipboardMirrorRestartTimer) {
      clearTimeout(clipboardMirrorRestartTimer);
      clipboardMirrorRestartTimer = null;
    }
    if (clipboardMirrorProc) {
      const proc = clipboardMirrorProc;
      clipboardMirrorProc = null;
      try { proc.kill(); } catch (_error) {}
    }
    releaseClipboardMirrorLock();
  }

  function isProcessAlive(pid) {
    const safePid = Number(pid);
    if (!Number.isInteger(safePid) || safePid <= 0) return false;
    const killFn = typeof processObj.kill === 'function' ? processObj.kill.bind(processObj) : process.kill.bind(process);
    try {
      killFn(safePid, 0);
      return true;
    } catch (_error) {
      return false;
    }
  }

  function acquireClipboardMirrorLock() {
    if (clipboardMirrorLockOwned) return true;
    const rootDir = resolveAihRunPath(aiHomeDir, 'locks');
    const lockPath = path.join(rootDir, 'windows-clipboard-mirror.lock');
    try {
      fs.mkdirSync(rootDir, { recursive: true });
    } catch (_error) {
      return false;
    }

    try {
      const fd = fs.openSync(lockPath, 'wx');
      const payload = {
        pid: processObj.pid,
        createdAt: Date.now()
      };
      fs.writeFileSync(fd, `${JSON.stringify(payload)}\n`, 'utf8');
      fs.closeSync(fd);
      clipboardMirrorLockPath = lockPath;
      clipboardMirrorLockOwned = true;
      return true;
    } catch (_error) {}

    try {
      const raw = String(fs.readFileSync(lockPath, 'utf8') || '').trim();
      const info = raw ? JSON.parse(raw) : null;
      const ownerPid = Number(info && info.pid);
      if (!isProcessAlive(ownerPid)) {
        fs.unlinkSync(lockPath);
        const fd = fs.openSync(lockPath, 'wx');
        const payload = {
          pid: processObj.pid,
          createdAt: Date.now()
        };
        fs.writeFileSync(fd, `${JSON.stringify(payload)}\n`, 'utf8');
        fs.closeSync(fd);
        clipboardMirrorLockPath = lockPath;
        clipboardMirrorLockOwned = true;
        return true;
      }
    } catch (_error) {}

    return false;
  }

  function releaseClipboardMirrorLock() {
    if (!clipboardMirrorLockOwned || !clipboardMirrorLockPath) return;
    try { fs.unlinkSync(clipboardMirrorLockPath); } catch (_error) {}
    clipboardMirrorLockOwned = false;
    clipboardMirrorLockPath = '';
  }

  function startClipboardImageMirrorProcess() {
    if (!canBridgeWindowsClipboard()) return;
    if (String(processObj.env.AIH_WINDOWS_IMAGE_PASTE || '1') === '0') return;
    const defaultMirror = '0';
    if (String(processObj.env.AIH_WINDOWS_IMAGE_CLIPBOARD_MIRROR || defaultMirror) !== '1') return;
    if (isLogin) return;
    if (!isInteractiveSession()) return;
    if (typeof spawn !== 'function') return;
    // Cross-instance singleton: only one mirror poller should watch global clipboard.
    if (!acquireClipboardMirrorLock()) return;

    const wslMode = isWslPlatform();
    const ownerPid = processObj.platform === 'win32' ? Number(processObj.pid) : 0;
    const psScript = [
      "$ErrorActionPreference = 'SilentlyContinue'",
      'Add-Type -AssemblyName System.Windows.Forms',
      'Add-Type -AssemblyName System.Drawing',
      `$ownerPid = ${Number.isInteger(ownerPid) && ownerPid > 0 ? ownerPid : 0}`,
      '$allowedPidMap = @{}',
      '$allowedPidRefreshAt = [DateTime]::MinValue',
      'Add-Type -Namespace AihNative -Name User32 -MemberDefinition \'[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow(); [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, out int lpdwProcessId);\'',
      'function Update-AihAllowedPidMap {',
      '  $script:allowedPidMap = @{}',
      '  if ($ownerPid -le 0) { return }',
      '  $currentPid = [int]$ownerPid',
      '  for ($i = 0; $i -lt 16 -and $currentPid -gt 0; $i++) {',
      '    $script:allowedPidMap[[string]$currentPid] = $true',
      '    $proc = Get-CimInstance Win32_Process -Filter ("ProcessId = " + $currentPid) -ErrorAction SilentlyContinue',
      '    if ($null -eq $proc) { break }',
      '    $parentPid = [int]$proc.ParentProcessId',
      '    if ($parentPid -le 0 -or $parentPid -eq $currentPid) { break }',
      '    $currentPid = $parentPid',
      '  }',
      '  $script:allowedPidRefreshAt = [DateTime]::UtcNow.AddSeconds(2)',
      '}',
      'function Test-AihForegroundWindow {',
      '  if ($ownerPid -le 0) { return $true }',
      '  if ([DateTime]::UtcNow -ge $script:allowedPidRefreshAt -or $script:allowedPidMap.Count -eq 0) { Update-AihAllowedPidMap }',
      '  if ($script:allowedPidMap.Count -eq 0) { return $false }',
      '  $hwnd = [AihNative.User32]::GetForegroundWindow()',
      '  if ($hwnd -eq [System.IntPtr]::Zero) { return $false }',
      '  $foregroundPid = 0',
      '  [void][AihNative.User32]::GetWindowThreadProcessId($hwnd, [ref]$foregroundPid)',
      '  if ($foregroundPid -le 0) { return $false }',
      '  return $script:allowedPidMap.ContainsKey([string][int]$foregroundPid)',
      '}',
      '$pendingImage = $false',
      '$pendingSince = [DateTime]::UtcNow',
      `$wslMode = $${wslMode ? 'true' : 'false'}`,
      'while ($true) {',
      '  try {',
      '    if (-not (Test-AihForegroundWindow)) {',
      '      $pendingImage = $false',
      '      Start-Sleep -Milliseconds 60',
      '      continue',
      '    }',
      '    if ([System.Windows.Forms.Clipboard]::ContainsImage()) {',
      '      if (-not $pendingImage) {',
      '        $pendingImage = $true',
      '      }',
      '      $pendingSince = [DateTime]::UtcNow',
      '    }',
      '    if ($pendingImage) {',
      '      $handled = $false',
      '      if ([System.Windows.Forms.Clipboard]::ContainsImage()) {',
      '        $img = [System.Windows.Forms.Clipboard]::GetImage()',
      '        if ($null -ne $img) {',
      '          $dir = Join-Path $env:TEMP "aih-image-paste"',
      '          [System.IO.Directory]::CreateDirectory($dir) | Out-Null',
      '          $cutoff = [DateTime]::UtcNow.AddDays(-1)',
      '          Get-ChildItem -LiteralPath $dir -File -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTimeUtc -lt $cutoff } | ForEach-Object { try { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue } catch {} }',
      '          $file = Join-Path $dir ("aih_clip_" + [DateTime]::Now.ToString("yyyyMMdd_HHmmss_fff") + ".png")',
      '          $img.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)',
      '          if ($wslMode) {',
      '            if ($file -match "^[A-Za-z]:\\\\") {',
      '              $drive = $file.Substring(0, 1).ToLower()',
      '              $rest = $file.Substring(2).Replace("\\\\", "/")',
      '              $pastePath = "/mnt/" + $drive + $rest',
      '            } else {',
      '              $pastePath = $file',
      '            }',
      '            [System.Windows.Forms.Clipboard]::SetText($pastePath)',
      '          } else {',
      '            [System.Windows.Forms.Clipboard]::SetText($file)',
      '          }',
      '          $handled = $true',
      '        }',
      '      }',
      '      if ($handled) {',
      '        $pendingImage = $false',
      '      } else {',
      '        $ageMs = ([DateTime]::UtcNow - $pendingSince).TotalMilliseconds',
      '        if ($ageMs -gt 3000) { $pendingImage = $false }',
      '      }',
      '    }',
      '  } catch {}',
      '  Start-Sleep -Milliseconds 30',
      '}'
    ].join('; ');

    const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
    const candidates = wslMode
      ? ['powershell.exe', 'powershell']
      : ['powershell.exe', 'powershell', 'pwsh.exe', 'pwsh'];

    const scheduleMirrorRestart = () => {
      if (isCleanedUp()) return;
      if (clipboardMirrorRestartTimer) return;
      clipboardMirrorRestartTimer = setTimeout(() => {
        clipboardMirrorRestartTimer = null;
        trySpawn(0);
      }, 1200);
      if (clipboardMirrorRestartTimer && typeof clipboardMirrorRestartTimer.unref === 'function') {
        clipboardMirrorRestartTimer.unref();
      }
    };

    const trySpawn = (index) => {
      if (index >= candidates.length) {
        releaseClipboardMirrorLock();
        return;
      }
      if (isCleanedUp()) return;
      const cmd = candidates[index];
      let child = null;
      try {
        child = spawn(cmd, ['-NoProfile', '-STA', '-EncodedCommand', encoded], {
          cwd: processObj.cwd(),
          env: { ...processObj.env },
          stdio: ['ignore', 'ignore', 'ignore']
        });
      } catch (_error) {
        trySpawn(index + 1);
        return;
      }
      if (!child || typeof child.on !== 'function') {
        trySpawn(index + 1);
        return;
      }
      let resolved = false;
      child.on('spawn', () => {
        resolved = true;
        clipboardMirrorProc = child;
      });
      child.on('error', () => {
        if (clipboardMirrorProc === child) clipboardMirrorProc = null;
        if (!resolved) {
          trySpawn(index + 1);
          return;
        }
        releaseClipboardMirrorLock();
        scheduleMirrorRestart();
      });
      child.on('exit', () => {
        if (clipboardMirrorProc === child) clipboardMirrorProc = null;
        if (!resolved) {
          trySpawn(index + 1);
          return;
        }
        releaseClipboardMirrorLock();
        scheduleMirrorRestart();
      });
    };

    trySpawn(0);
  }

  return {
    isClipboardPasteTrigger,
    tryCaptureClipboardImagePathOnWindows,
    startClipboardImageMirrorProcess,
    stopClipboardMirrorProcess
  };
}

module.exports = {
  createLocalClipboard
};
