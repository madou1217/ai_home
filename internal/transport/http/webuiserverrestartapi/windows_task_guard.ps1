$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2
$plan = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($PlanBase64)) | ConvertFrom-Json

function Fail([string]$code) { throw $code }
function Same-Path([string]$left, [string]$right) {
    if ([string]::IsNullOrWhiteSpace($left) -or [string]::IsNullOrWhiteSpace($right)) { return $false }
    try { return [IO.Path]::GetFullPath($left).TrimEnd('\') -ieq [IO.Path]::GetFullPath($right).TrimEnd('\') } catch { return $false }
}
function File-Hash([string]$path) { return (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Read-Identity {
    return [IO.File]::ReadAllText([string]$plan.identityPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
}
function Process-StartID($process) {
    $stamp = [DateTimeOffset]($process.StartTime.ToUniversalTime())
    return 'windows:' + $stamp.ToUnixTimeMilliseconds().ToString([Globalization.CultureInfo]::InvariantCulture)
}
function Assert-OldProcess {
    $process = Get-Process -Id ([int]$plan.oldPid) -ErrorAction Stop
    if ((Process-StartID $process) -ne [string]$plan.oldStartId -or !(Same-Path $process.Path $plan.executable)) { Fail 'server_restart_process_mismatch' }
    return $process
}
function Assert-Identity {
    $identity = Read-Identity
    if ([int]$identity.version -ne 1 -or [int]$identity.pid -ne [int]$plan.oldPid -or
        [string]$identity.processStartId -ne [string]$plan.oldStartId -or
        !(Same-Path $identity.aiHomeDir $plan.home) -or !(Same-Path $identity.executable $plan.executable)) { Fail 'server_restart_identity_changed' }
    $null = Assert-OldProcess
}
function Assert-Task {
    if ((File-Hash $plan.marker) -ne [string]$plan.markerSha256 -or (File-Hash $plan.script) -ne [string]$plan.scriptSha256) { Fail 'server_restart_metadata_changed' }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    if ($identity.User.Value -ne [string]$plan.userSid) { Fail 'server_restart_user_mismatch' }
    $service = New-Object -ComObject Schedule.Service
    $service.Connect()
    $task = $service.GetFolder('\').GetTask([string]$plan.task)
    if ($task.Path -ine ('\' + [string]$plan.task) -or !$task.Enabled -or [int]$task.State -eq 1) { Fail 'server_restart_task_unavailable' }
    $definition = $task.Definition
    if (!$definition.Settings.AllowDemandStart) { Fail 'server_restart_task_demand_start_disabled' }
    if ($definition.Actions.Count -ne 1) { Fail 'server_restart_task_actions_mismatch' }
    $action = $definition.Actions.Item(1)
    if ([int]$action.Type -ne 0 -or ![string]::IsNullOrWhiteSpace([string]$action.Arguments) -or
        !(Same-Path ([string]$action.Path).Trim('"') $plan.script)) { Fail 'server_restart_task_action_mismatch' }
    if ([int]$definition.Principal.RunLevel -ne 0 -or [int]$definition.Principal.LogonType -notin @(2,3)) { Fail 'server_restart_task_principal_unsafe' }
    $account = New-Object Security.Principal.NTAccount([string]$definition.Principal.UserId)
    if ($account.Translate([Security.Principal.SecurityIdentifier]).Value -ne [string]$plan.userSid) { Fail 'server_restart_task_user_mismatch' }
    return $task
}
function Assert-TaskOwner($task, [int]$daemonPid, [string]$startId, [string]$instanceGuid = '') {
    $instances = $task.GetInstances(0)
    if ($instances.Count -ne 1) { Fail 'server_restart_task_instance_mismatch' }
    $instance = $instances.Item(1)
    $enginePid = [int]$instance.EnginePID
    $guid = [string]$instance.InstanceGuid
    if ($enginePid -le 0 -or [string]::IsNullOrWhiteSpace($guid) -or $instance.Path -ine $task.Path -or
        ($instanceGuid -ne '' -and $guid -ine $instanceGuid)) { Fail 'server_restart_task_engine_unavailable' }
    $leaf = Get-Process -Id $daemonPid -ErrorAction Stop
    if ((Process-StartID $leaf) -ne $startId -or !(Same-Path $leaf.Path $plan.executable)) { Fail 'server_restart_process_mismatch' }
    $engine = Get-Process -Id $enginePid -ErrorAction Stop
    $engineStart = Process-StartID $engine
    # For this CMD launcher contract the actual task EnginePID must be the launcher,
    # not merely a shared services.exe/svchost ancestor or a same-script manual CMD.
    $walk = $daemonPid
    $childCreated = [DateTime]::MaxValue
    $matched = $false
    $seen = @{}
    for ($i = 0; $i -lt 12 -and $walk -gt 0; $i++) {
        if ($seen.ContainsKey($walk)) { break }
        $seen[$walk] = $true
        $process = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $walk) -ErrorAction Stop
        if ($null -eq $process -or $process.CreationDate -gt $childCreated) { break }
        if ($walk -eq $enginePid) {
            $expected = [regex]::Escape([string]$plan.script)
            $matched = [string]$process.Name -ieq 'cmd.exe' -and
                ([string]$process.CommandLine -imatch ('(?:^|\s)/c\s+"{0,2}' + $expected + '"{0,2}\s*$'))
            break
        }
        $childCreated = $process.CreationDate
        $walk = [int]$process.ParentProcessId
    }
    if (!$matched) { Fail 'server_restart_task_process_owner_mismatch' }
    $current = $task.GetInstances(0)
    if ($current.Count -ne 1 -or [string]$current.Item(1).InstanceGuid -ine $guid -or
        [int]$current.Item(1).EnginePID -ne $enginePid -or
        (Process-StartID (Get-Process -Id $enginePid -ErrorAction Stop)) -ne $engineStart -or
        (Process-StartID (Get-Process -Id $daemonPid -ErrorAction Stop)) -ne $startId) { Fail 'server_restart_task_instance_changed' }
    return $instance
}
function Assert-SafePlan {
    Assert-Identity
    $task = Assert-Task
    $null = Assert-TaskOwner $task ([int]$plan.oldPid) ([string]$plan.oldStartId)
    return $task
}
