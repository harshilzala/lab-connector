<#
  Lab-Interface - force stop (engine).

  Run Lab-Interface-force-stop.bat (or magic\magic-force-stop.bat) instead of
  this file unless you want the switches below; the .bat files are the
  double-clickable wrappers.

  Why this exists next to Lab-Interface-stop.bat
  ------------------------------------------------
  Lab-Interface-stop.bat only knows how to stop the connector when PM2 is
  managing it. On this machine the connector is a Windows SERVICE
  (service\LAB-Interface-service.xml, run by WinSW as LocalSystem), and PM2 has
  nothing to do with it. Killing the service's node process is not a stop
  either: the Service Control Manager treats that as a crash and starts it
  again 10 seconds later - which is exactly what took the analyzer ports back
  from every "npm run dev" attempt. The 5-minute watchdog task does the same
  job from the other side. This script stops ALL of it, however the connector
  was started, and keeps it stopped.

  What it does, in order
  ----------------------
    1. Raises the .lab-maintenance flag, so a watchdog tick landing in the
       middle of the stop does not start it again. Same flag, same meaning as
       Lab-Interface-stop.bat: it stays down until Lab-Interface.bat runs.
    2. Watchdog: kills any watchdog worker that is running right now
       (magic-startup.cmd / Lab-Interface-startup.cmd) and DISABLES the
       5-minute scheduled tasks ("Lab-Interface Watchdog - <user>" and
       "magic Lab Connector Watchdog - <user>"). Disabled, not deleted:
       Lab-Interface.bat / magic-start.bat enable them again.
    3. Windows service: stops the LAB-Interface service through the SCM (a
       clean stop, so it is NOT restarted as a crash) and sets its start type
       to Manual so a reboot does not bring it back while it is meant to be
       down. Lab-Interface.bat restores Automatic (delayed) start.
       Stopping a LocalSystem service needs administrator rights, so the
       script relaunches itself elevated (one UAC prompt) when the service is
       installed and the current session is not elevated.
    4. Stops the PM2 apps if PM2 has them (SIGTERM, kill_timeout 8s to flush),
       under the current name and the retired "GENEX-Interface" / "lab-connector";
       pm2 save, so a logon does not resurrect it.
    5. Sweeps up anything still running: node.exe processes on this project's
       compiled entry point, plus whatever is holding the admin dashboard port
       (that also catches a stray "npm run dev"). Each one is asked to close
       first, and only killed hard if it is still there after -GraceSeconds.
    6. Verifies nothing is left, and says so.

  Analyzer results already written to .\spool stay on disk and are delivered
  when the connector next starts - stopping never loses them.

  Exit code 0 = nothing is running any more. 1 = something survived (the
  message says what).
#>
[CmdletBinding()]
param(
  # How long a process gets to close on its own before it is killed hard.
  [int] $GraceSeconds = 12,

  # Stop without raising .lab-maintenance, without disabling the watchdog
  # tasks and without changing the service start type. The watchdog will then
  # start the connector again within 5 minutes - only useful for a deliberate
  # bounce.
  [switch] $KeepWatchdogArmed,

  # Do not relaunch elevated. Without elevation the Windows service cannot be
  # stopped and its node process cannot be killed; the script reports that
  # instead of prompting.
  [switch] $NoElevate,

  # Set by the script itself on the elevated relaunch. Keeps the elevated
  # console open at the end so the operator can read what happened.
  [switch] $Elevated
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$flag = Join-Path $root '.lab-maintenance'
$serviceName = 'LAB-Interface'

# Same PM2 home as Lab-Interface.bat - beside the connector, writable by every
# operator - so this script stops the connector without "Run as administrator".
# The machine-wide C:\ProgramData\pm2\home is owned by the LocalSystem PM2
# service and grants Users read only, which made every unelevated pm2 call fail
# with EPERM on pm2.pid. See the long note in Lab-Interface.bat.
$env:PM2_HOME = Join-Path $root '.pm2'

function Write-Step { param([string] $Text) Write-Host "  $Text" }

function Test-Elevated {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# Run a console tool with its chatter suppressed, and report only its exit code.
#
# PowerShell 5.1 raises a TERMINATING NativeCommandError when a native command
# writes to stderr while $ErrorActionPreference is 'Stop' - even when the tool
# exited 0. pm2 ("Lab-Interface doesn't exist") and taskkill ("process not
# found") both write to stderr as a matter of routine, so redirecting their
# output the obvious way would abort this script mid-stop. Relax the preference
# for the duration of the call and judge the result by $LASTEXITCODE, which is
# the only reliable signal from a native tool anyway.
function Invoke-Quiet {
  param(
    [Parameter(Mandatory = $true)] [string] $FilePath,
    [Parameter(ValueFromRemainingArguments = $true)] [string[]] $Arguments
  )
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $FilePath @Arguments 2>&1 | Out-Null
    return $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previous
  }
}

# The admin dashboard port is the one thing this connector always binds, which
# makes it the most reliable "is that process ours" test. config.json is JSONC,
# so plain ConvertFrom-Json is tried first and comment-stripping is the
# fallback; 7071/7070 (current config / schema default) are the last resort.
function Get-ConnectorPort {
  $cfgPath = Join-Path $root 'config.json'
  if (Test-Path -LiteralPath $cfgPath) {
    $raw = Get-Content -LiteralPath $cfgPath -Raw
    foreach ($text in @($raw, [regex]::Replace($raw, '(?m)(?<![:"\w])//.*$', ''))) {
      try {
        $cfg = $text | ConvertFrom-Json
        if ($cfg.admin.port) { return @([int] $cfg.admin.port) }
      } catch { }
    }
    Write-Step 'note: could not read admin.port from config.json - falling back to 7071/7070.'
  }
  return @(7071, 7070)
}

function Get-ConnectorProcess {
  $found = @{}

  # a) node running this project's compiled entry point.
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'dist[\\/]index\.js' } |
    ForEach-Object { $found[[int] $_.ProcessId] = $_ }

  # b) whoever is holding the admin port - catches a connector started with a
  #    different command line ("npm run dev" / tsx watch, or the service child,
  #    whose command line LocalSystem hides from an unelevated session), and
  #    confirms the ones found above.
  foreach ($port in Get-ConnectorPort) {
    Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue |
      ForEach-Object {
        $procId = [int] $_.OwningProcess
        if (-not $found.ContainsKey($procId)) {
          $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$procId" -ErrorAction SilentlyContinue
          if ($proc -and $proc.Name -eq 'node.exe') { $found[$procId] = $proc }
        }
      }
  }

  # Never target this PowerShell session itself.
  $found.Remove($PID)
  return @($found.Values)
}

function Stop-ConnectorProcess {
  param($Proc)

  $procId = [int] $Proc.ProcessId
  $label = $Proc.CommandLine
  if (-not $label) { $label = '(command line not visible - owned by another account)' }
  Write-Step ("PID {0} - {1}" -f $procId, $label)

  # Ask first (no /F). /T takes any child it spawned with it.
  [void] (Invoke-Quiet taskkill.exe /PID $procId /T)

  $deadline = (Get-Date).AddSeconds($GraceSeconds)
  while ((Get-Process -Id $procId -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 250
  }

  if (Get-Process -Id $procId -ErrorAction SilentlyContinue) {
    Write-Step ("PID {0} did not close in {1}s - killing it." -f $procId, $GraceSeconds)
    [void] (Invoke-Quiet taskkill.exe /F /PID $procId /T)
    Start-Sleep -Milliseconds 500
  }

  if (Get-Process -Id $procId -ErrorAction SilentlyContinue) {
    # Stopping your own connector never needs elevation. This branch means the
    # process belongs to somebody else - the LocalSystem LAB-Interface service
    # or PM2 service started it - and only an elevated session can end it.
    Write-Step ("PID {0} SURVIVED - it is owned by another account (the LAB-Interface or PM2 service); only an elevated session can stop that one." -f $procId)
    return $false
  }

  Write-Step ("PID {0} stopped." -f $procId)
  return $true
}

# ---- watchdog ---------------------------------------------------------------
# Both generations of the 5-minute watchdog task, for every operator account:
#   "Lab-Interface Watchdog - <user>"          registered by Lab-Interface.bat
#   "magic Lab Connector Watchdog - <user>"    registered by magic\magic-add-to-startup.bat
#   "Lab-Interface Watchdog"                   the retired shared one
# plus anything else whose action points into this project folder.
$watchdogWorkerPattern = 'magic-startup\.cmd|Lab-Interface-startup(-hidden\.vbs|\.cmd)'

function Get-WatchdogTask {
  $rootPattern = [regex]::Escape($root)
  Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object {
    $task = $_
    if ($task.TaskName -like 'Lab-Interface Watchdog*') { return $true }
    if ($task.TaskName -like 'magic Lab Connector Watchdog*') { return $true }
    foreach ($action in @($task.Actions)) {
      if (("{0} {1}" -f $action.Execute, $action.Arguments) -match $rootPattern) { return $true }
    }
    return $false
  }
}

function Stop-Watchdog {
  # a) a worker that is running this very moment (they are short-lived, but a
  #    tick can land while this script is stopping things).
  $workers = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { ($_.Name -in 'cmd.exe', 'wscript.exe', 'cscript.exe') -and $_.CommandLine -match $watchdogWorkerPattern })
  foreach ($worker in $workers) {
    if ([int] $worker.ProcessId -eq $PID) { continue }
    [void] (Invoke-Quiet taskkill.exe /F /PID $worker.ProcessId /T)
    Write-Step ("[2/6] watchdog: killed running worker PID {0} ({1})." -f $worker.ProcessId, $worker.Name)
  }

  # b) the scheduled tasks themselves.
  $tasks = @(Get-WatchdogTask)
  if ($tasks.Count -eq 0) {
    Write-Step '[2/6] watchdog: no watchdog task is registered.'
    return @()
  }
  $failed = @()
  foreach ($task in $tasks) {
    $name = $task.TaskName
    try {
      if ($task.State -eq 'Running') { Stop-ScheduledTask -TaskName $name -TaskPath $task.TaskPath -ErrorAction Stop }
      if ($task.State -eq 'Disabled') {
        Write-Step ("[2/6] watchdog: task ""{0}"" was already disabled." -f $name)
      } else {
        [void] (Disable-ScheduledTask -TaskName $name -TaskPath $task.TaskPath -ErrorAction Stop)
        Write-Step ("[2/6] watchdog: task ""{0}"" disabled." -f $name)
      }
    } catch {
      $failed += $name
      Write-Step ("[2/6] watchdog: could NOT disable task ""{0}"" - {1}" -f $name, $_.Exception.Message.Trim())
    }
  }
  return $failed
}

# ---- Windows service --------------------------------------------------------
function Stop-ConnectorService {
  $svc = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
  if (-not $svc) {
    Write-Step "[3/6] service: $serviceName is not installed on this machine."
    return $true
  }

  if ($svc.Status -eq 'Stopped') {
    Write-Step "[3/6] service: $serviceName is already stopped."
  } else {
    if (-not (Test-Elevated)) {
      Write-Step "[3/6] service: $serviceName is $($svc.Status) and this session is not elevated - it CANNOT be stopped from here."
      Write-Step '       Run Lab-Interface-force-stop.bat again and accept the administrator prompt.'
      return $false
    }
    Write-Step "[3/6] service: stopping $serviceName (clean SCM stop - it will not be restarted as a crash)..."
    try {
      Stop-Service -Name $serviceName -Force -ErrorAction Stop
      $svc.WaitForStatus('Stopped', [TimeSpan]::FromSeconds($GraceSeconds + 15))
      Write-Step "[3/6] service: $serviceName stopped."
    } catch {
      Write-Step ("[3/6] service: stop FAILED - {0}" -f $_.Exception.Message.Trim())
      return $false
    }
  }

  if ($KeepWatchdogArmed) {
    Write-Step '[3/6] service: start type left as it is (-KeepWatchdogArmed).'
    return $true
  }

  if (-not (Test-Elevated)) {
    Write-Step '[3/6] service: not elevated, so the start type stays Automatic - a reboot WILL start it again.'
    return $true
  }
  $rc = Invoke-Quiet sc.exe config $serviceName start= demand
  if ($rc -eq 0) {
    Write-Step '[3/6] service: start type set to Manual - a reboot will not bring it back. Lab-Interface.bat restores Automatic.'
  } else {
    Write-Step ("[3/6] service: could not change the start type (sc.exe exit {0}) - a reboot may start it again." -f $rc)
  }
  return $true
}

# ---- elevation --------------------------------------------------------------
# Only the service needs administrator rights. If it is installed and running
# and we are not elevated, hand the whole job to an elevated copy of this
# script - one UAC prompt, and everything (flag, watchdog, service, sweep)
# happens in that window.
$serviceInstalled = [bool] (Get-Service -Name $serviceName -ErrorAction SilentlyContinue)
if ($serviceInstalled -and -not $NoElevate -and -not $Elevated -and -not (Test-Elevated)) {
  Write-Host ''
  Write-Host "  $serviceName is installed as a Windows service. Stopping it needs administrator rights -"
  Write-Host '  relaunching this script elevated (accept the prompt; a second window opens).'
  Write-Host ''
  $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"{0}"' -f $PSCommandPath),
               '-GraceSeconds', $GraceSeconds, '-Elevated')
  if ($KeepWatchdogArmed) { $argList += '-KeepWatchdogArmed' }
  try {
    $child = Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList ($argList -join ' ') -Wait -PassThru -ErrorAction Stop
    $code = $child.ExitCode
  } catch {
    Write-Host '  The administrator prompt was cancelled - nothing was stopped.'
    Write-Host '  (Use -NoElevate to stop only what this account owns: PM2 apps, your own watchdog task, and any "npm run dev".)'
    Write-Host ''
    exit 1
  }
  if ($code -eq 0) { Write-Host '  Done - see the elevated window for details. Lab-Interface is stopped.' }
  else { Write-Host '  The elevated stop reported a problem - see its window.' }
  Write-Host ''
  exit $code
}

function Wait-BeforeClose {
  if ($Elevated) {
    Write-Host '  Press Enter to close this window.'
    [void] (Read-Host)
  }
}

Write-Host ''
Write-Host ' =========================================================='
Write-Host '  Lab-Interface - force stop'
Write-Host "  folder: $root"
if (Test-Elevated) { Write-Host '  (running elevated)' }
Write-Host ' =========================================================='
Write-Host ''

# ---- 1. maintenance flag, before anything is stopped ------------------------
if ($KeepWatchdogArmed) {
  Write-Step '[1/6] maintenance flag NOT raised (-KeepWatchdogArmed): the watchdog may start it again within 5 minutes.'
} else {
  "Stopped by Lab-Interface-force-stop.ps1 on $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" |
    Set-Content -LiteralPath $flag -Encoding ASCII
  Write-Step '[1/6] maintenance flag raised - the watchdog will leave it alone.'
}

# ---- 2. watchdog -----------------------------------------------------------
$watchdogFailed = @()
if ($KeepWatchdogArmed) {
  Write-Step '[2/6] watchdog tasks left armed (-KeepWatchdogArmed).'
} else {
  $watchdogFailed = @(Stop-Watchdog)
}

# ---- 3. Windows service ----------------------------------------------------
$serviceOk = Stop-ConnectorService

# ---- 4. PM2 ----------------------------------------------------------------
$pm2 = Get-Command 'pm2.cmd', 'pm2' -CommandType Application -ErrorAction SilentlyContinue |
  Select-Object -First 1
$pm2Managed = $false

if ($pm2) {
  foreach ($app in 'Lab-Interface', 'GENEX-Interface', 'lab-connector') {
    $describeExit = Invoke-Quiet $pm2.Source describe $app
    if ($describeExit -eq 0) {
      $pm2Managed = $true
      Write-Step "[4/6] PM2: stopping $app (SIGTERM, up to 8s to flush the spool)..."
      [void] (Invoke-Quiet $pm2.Source stop $app)
      [void] (Invoke-Quiet $pm2.Source save)
      Write-Step "[4/6] PM2: $app stopped, and the stopped state saved."
    }
  }
  if (-not $pm2Managed) { Write-Step '[4/6] PM2 has no Lab-Interface entry - nothing to stop there.' }
} else {
  Write-Step '[4/6] PM2 is not on PATH - skipping the PM2 stop.'
}

# ---- 5. sweep --------------------------------------------------------------
$targets = @(Get-ConnectorProcess)
if ($targets.Count -eq 0) {
  Write-Step '[5/6] no connector process is running.'
} else {
  Write-Step ("[5/6] {0} connector process(es) still running:" -f $targets.Count)
  foreach ($target in $targets) { [void] (Stop-ConnectorProcess -Proc $target) }
}

# ---- 6. verify -------------------------------------------------------------
Start-Sleep -Milliseconds 500
$left = @(Get-ConnectorProcess)
$svcNow = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
$serviceStillUp = ($svcNow -and $svcNow.Status -ne 'Stopped')

Write-Host ''
if ($left.Count -eq 0 -and -not $serviceStillUp -and $watchdogFailed.Count -eq 0) {
  Write-Step '[6/6] verified: nothing is listening, nothing is running, nothing will restart it.'
  Write-Host ''
  Write-Host ' =========================================================='
  if ($KeepWatchdogArmed) {
    Write-Host '  Lab-Interface is stopped. The watchdog is still armed,'
    Write-Host '  so it will come back within 5 minutes.'
  } else {
    Write-Host '  Lab-Interface is stopped and will STAY stopped'
    Write-Host '  (service stopped + Manual, watchdog disabled, flag raised).'
    Write-Host '  Start it again with Lab-Interface.bat'
  }
  Write-Host ' =========================================================='
  Write-Host ''
  Wait-BeforeClose
  exit 0
}

if ($serviceStillUp) {
  Write-Step ("[6/6] STILL RUNNING: the {0} service is {1}." -f $serviceName, $svcNow.Status)
  if (-not (Test-Elevated)) { Write-Step 'Run Lab-Interface-force-stop.bat as administrator (or accept its prompt) to stop the service.' }
}
if ($left.Count -gt 0) {
  Write-Step ("[6/6] STILL RUNNING: PID(s) {0}." -f (($left | ForEach-Object { $_.ProcessId }) -join ', '))
  if ($pm2Managed) {
    Write-Step 'PM2 started it again. Run this script once more, or remove the entry with: pm2 delete Lab-Interface'
  } elseif (-not (Test-Elevated)) {
    Write-Step 'The process belongs to another account (LocalSystem). Run this script elevated to end it.'
  }
}
if ($watchdogFailed.Count -gt 0) {
  Write-Step ("[6/6] watchdog task(s) still armed: {0}." -f ($watchdogFailed -join ', '))
  Write-Step 'They belong to another operator account - run this script elevated, or that account can disable them.'
}
Write-Host ''
Wait-BeforeClose
exit 1
