param(
  [switch]$InstallLogonTask
)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$stateDir = Join-Path $projectRoot 'data\viewfinder-captures'
$bridgeScript = Join-Path $projectRoot 'scripts\viewfinder-bridge.mjs'
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
$sshExe = 'C:\Windows\System32\OpenSSH\ssh.exe'
$keyPath = $env:QIUQIU_SSH_KEY_PATH
$sshTarget = $env:QIUQIU_SSH_TARGET
$taskName = 'ViewfinderBridgeTunnel'
$logPath = Join-Path $stateDir 'viewfinder-supervisor.log'
$bridgeOutPath = Join-Path $stateDir 'bridge.stdout.log'
$bridgeErrorPath = Join-Path $stateDir 'bridge.stderr.log'
$sshErrorPath = Join-Path $stateDir 'tunnel-ssh.stderr.log'

if ($InstallLogonTask) {
  $powershellExe = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
  $taskArguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$PSCommandPath`""
  $action = New-ScheduledTaskAction -Execute $powershellExe -Argument $taskArguments
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name)
  $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable
  $principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Keeps the local Viewfinder bridge and its loopback-only SSH reverse tunnel available.' -Force | Out-Null
  Write-Output "Installed logon task: $taskName"
  exit 0
}

if (!$nodeCommand -or !(Test-Path -LiteralPath $sshExe) -or [string]::IsNullOrWhiteSpace($keyPath) -or [string]::IsNullOrWhiteSpace($sshTarget) -or !(Test-Path -LiteralPath $keyPath)) {
  throw 'Existing Node.js, OpenSSH, QIUQIU_SSH_KEY_PATH, or QIUQIU_SSH_TARGET is missing'
}
New-Item -ItemType Directory -Path $stateDir -Force | Out-Null

function Write-SupervisorLog([string]$message) {
  Add-Content -LiteralPath $logPath -Value "$(Get-Date -Format o) $message"
}

function Test-BridgeListener {
  foreach ($port in @(3100, 3200)) {
    $client = [System.Net.Sockets.TcpClient]::new()
    try {
      $result = $client.BeginConnect('127.0.0.1', $port, $null, $null)
      if (!$result.AsyncWaitHandle.WaitOne(750)) { return $false }
      $client.EndConnect($result)
    } catch { return $false }
    finally { $client.Dispose() }
  }
  return $true
}

function Ensure-Bridge {
  if (Test-BridgeListener) { return }
  Write-SupervisorLog 'Bridge listener unavailable; starting existing bridge script'
  $nodeExe = $nodeCommand.Source
  Start-Process -FilePath $nodeExe -ArgumentList @('"' + $bridgeScript + '"') -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput $bridgeOutPath -RedirectStandardError $bridgeErrorPath | Out-Null
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 500
    if (Test-BridgeListener) {
      Write-SupervisorLog 'Bridge HTTP and WebSocket listeners are ready'
      return
    }
  }
  Write-SupervisorLog 'Bridge did not become ready; next supervisor check will retry'
}

# A global mutex also prevents two interactive logon sessions from owning duplicate tunnels.
$mutex = [System.Threading.Mutex]::new($false, 'Global\ViewfinderBridgeTunnelSupervisor')
if (!$mutex.WaitOne(0)) {
  Write-SupervisorLog 'Another supervisor instance is already running; exiting'
  exit 0
}

$retrySeconds = 5
try {
  Write-SupervisorLog 'Supervisor started'
  while ($true) {
    Ensure-Bridge
    if (!(Test-BridgeListener)) {
      Start-Sleep -Seconds 5
      continue
    }

    $arguments = @(
      '-N', '-T',
      '-i', $keyPath,
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=yes',
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ServerAliveInterval=30',
      '-o', 'ServerAliveCountMax=3',
      '-R', '127.0.0.1:43100:127.0.0.1:3100',
      '-L', '127.0.0.1:34173:127.0.0.1:4173',
      $sshTarget
    )
    Write-SupervisorLog "Starting SSH reverse tunnel; retry delay after failure is $retrySeconds seconds"
    $child = Start-Process -FilePath $sshExe -ArgumentList $arguments -WindowStyle Hidden -RedirectStandardError $sshErrorPath -PassThru
    Set-Content -LiteralPath (Join-Path $stateDir 'tunnel-ssh.pid') -Value $child.Id

    while (!$child.HasExited) {
      Ensure-Bridge
      Start-Sleep -Seconds 5
      $child.Refresh()
    }

    Write-SupervisorLog "SSH reverse tunnel exited with code $($child.ExitCode); reconnecting after $retrySeconds seconds"
    Remove-Item -LiteralPath (Join-Path $stateDir 'tunnel-ssh.pid') -ErrorAction SilentlyContinue
    Start-Sleep -Seconds $retrySeconds
    $retrySeconds = [Math]::Min($retrySeconds * 2, 60)
  }
} catch {
  Write-SupervisorLog "Supervisor error: $($_.Exception.Message)"
  throw
} finally {
  $mutex.ReleaseMutex()
  $mutex.Dispose()
}
