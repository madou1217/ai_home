$ErrorActionPreference = 'Stop'
$lock = $null
$stage = 'preflight'
$oldEnginePid = 0
$newEnginePid = 0
$newInstanceGuid = ''
function Write-Status([string]$status, [string]$errorCode, [int]$newPid = 0) {
    $record = [ordered]@{version=1; jobId=[string]$plan.jobId; task=[string]$plan.task; status=$status; stage=$script:stage; oldPid=[int]$plan.oldPid; newPid=$newPid; oldEnginePid=$script:oldEnginePid; newEnginePid=$script:newEnginePid; taskInstanceGuid=$script:newInstanceGuid; createdAt=[long]$plan.createdAt; updatedAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); error=$errorCode}
    $json = $record | ConvertTo-Json -Compress
    $temp = [string]$plan.statusPath + '.tmp'
    [IO.File]::WriteAllText($temp, $json, (New-Object Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $temp -Destination ([string]$plan.statusPath) -Force
}
function Old-ProcessGone {
    $old = Get-Process -Id ([int]$plan.oldPid) -ErrorAction SilentlyContinue
    if ($null -eq $old) { return $true }
    return (Process-StartID $old) -ne [string]$plan.oldStartId
}
try {
    # Shared file lock prevents two detached restart helpers from racing the same task.
    $lock = [IO.File]::Open([string]$plan.lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    $task = Assert-SafePlan
    Write-Status 'validated' ''
    Start-Sleep -Milliseconds 500
    $task = Assert-SafePlan
    $instance = Assert-TaskOwner $task ([int]$plan.oldPid) ([string]$plan.oldStartId)
    $oldEnginePid = [int]$instance.EnginePID
    $oldInstanceGuid = [string]$instance.InstanceGuid
    $oldEngineStartId = Process-StartID (Get-Process -Id $oldEnginePid -ErrorAction Stop)
    $stage = 'awaiting_shutdown'
    # The caller invokes the host graceful shutdown callback after this handshake.
    # No key is written in this script, status, command line or helper environment.
    Write-Status 'armed' ''
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    while (!(Old-ProcessGone) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }
    if (!(Old-ProcessGone)) { Fail 'server_restart_graceful_shutdown_timeout' }
    $stage = 'stopping'
    Write-Status 'stopping' ''
    $task = Assert-Task
    $remaining = $task.GetInstances(0)
    if ($remaining.Count -gt 0) {
        if ($remaining.Count -ne 1 -or [string]$remaining.Item(1).InstanceGuid -ine $oldInstanceGuid -or
            [int]$remaining.Item(1).EnginePID -ne $oldEnginePid) { Fail 'server_restart_task_instance_changed' }
        $engine = Get-Process -Id $oldEnginePid -ErrorAction SilentlyContinue
        if ($null -ne $engine -and (Process-StartID $engine) -eq $oldEngineStartId) {
            # Only the already-validated old task instance may be stopped, after daemon exit.
            $remaining.Item(1).Stop()
        }
    }
    $deadline = [DateTime]::UtcNow.AddSeconds(5)
    do {
        Start-Sleep -Milliseconds 100
        $task = Assert-Task
        $stopped = $task.GetInstances(0).Count -eq 0 -and [int]$task.State -ne 4
    } while (!$stopped -and [DateTime]::UtcNow -lt $deadline)
    if (!$stopped) { Fail 'server_restart_task_stop_timeout' }
    # Recheck the action/home/principal immediately before Run; do not repair changed metadata.
    $task = Assert-Task
    $stage = 'starting'
    Write-Status 'starting' ''
    $launched = $task.Run($null)
    $newInstanceGuid = [string]$launched.InstanceGuid
    if ([string]::IsNullOrWhiteSpace($newInstanceGuid)) { Fail 'server_restart_task_instance_unavailable' }
    $stage = 'verifying'
    Write-Status 'verifying' ''
    $deadline = [DateTime]::UtcNow.AddSeconds(40)
    $verified = $false
    $successPid = 0
    do {
        Start-Sleep -Milliseconds 250
        try {
            $identity = Read-Identity
            if ([int]$identity.version -ne 1 -or [string]$identity.processStartId -eq [string]$plan.oldStartId -or
                !(Same-Path $identity.aiHomeDir $plan.home) -or !(Same-Path $identity.executable $plan.executable)) { continue }
            $new = Get-Process -Id ([int]$identity.pid) -ErrorAction Stop
            if ((Process-StartID $new) -ne [string]$identity.processStartId -or !(Same-Path $new.Path $plan.executable)) { continue }
            $port = [int]$identity.port
            if ($port -lt 1 -or $port -gt 65535) { continue }
            $hostName = [string]$identity.host
            if ($hostName -eq '0.0.0.0' -or $hostName -eq '127.0.0.1') { $hostName = '127.0.0.1' }
            elseif ($hostName -eq '::' -or $hostName -eq '::1') { $hostName = '[::1]' }
            else { continue }
            $task = Assert-Task
            if ([int]$task.State -ne 4 -or $task.GetInstances(0).Count -ne 1) { continue }
            $owned = Assert-TaskOwner $task ([int]$identity.pid) ([string]$identity.processStartId) $newInstanceGuid
            $newEnginePid = [int]$owned.EnginePID
            $health = Invoke-WebRequest -UseBasicParsing -Uri ('http://' + $hostName + ':' + $port + '/healthz') -TimeoutSec 2
            if ([int]$health.StatusCode -eq 200 -and (Old-ProcessGone)) {
                $null = Assert-TaskOwner $task ([int]$identity.pid) ([string]$identity.processStartId) $newInstanceGuid
                $successPid = [int]$identity.pid; $verified = $true
            }
        } catch { }
    } while (!$verified -and [DateTime]::UtcNow -lt $deadline)
    if (!$verified) { Fail 'server_restart_recovery_timeout' }
    $stage = 'complete'
    Write-Status 'succeeded' '' $successPid
    exit 0
} catch {
    $code = [string]$_.Exception.Message
    if ($code -notmatch '^server_restart_[a-z0-9_]+$') { $code = 'server_restart_' + $stage + '_failed' }
    try { Write-Status 'failed' $code } catch { }
    exit 1
} finally {
    if ($null -ne $lock) { $lock.Dispose() }
}
