<#
  LAB-Interface - resume after a force stop.

  The counterpart to Lab-Interface-force-stop.ps1. That script deliberately
  leaves the machine in a state where NOTHING can start the connector again:

    * .lab-maintenance raised          - the watchdog stands aside;
    * the watchdog tasks disabled      - the 5-minute backstop is off;
    * the LAB-Interface service stopped and set to Manual start
                                       - a reboot does not bring it back.

  That is the point of a force stop, but it means "just start it again" has to
  undo all three. This script does exactly that, in the reverse order, and is
  what Lab-Interface.bat and magic\magic-start.bat call when they find the
  connector installed as a Windows service.

  Windows lets only administrators start a service or change its start type by
  default. service\grant-user-control.ps1 (run once, elevated) gives
  BUILTIN\Users those rights on this one service, and from then on this script
  runs as the operator with no prompt. Only when the account still lacks the
  rights does it relaunch itself elevated (one UAC prompt).

  It refuses to start the service while another copy of the connector already
  holds the admin dashboard port (an "npm run dev" from a terminal, or a PM2
  copy): two connectors would fight over the analyzer ports and both post to
  HMIS. Stop that copy first, then run this again.

  Exit code 0 = the service is running. 1 = it is not (the message says why).
#>
[CmdletBinding()]
param(
  # Set by the script itself on the elevated relaunch, so the elevated window
  # stays open long enough to read.
  [switch] $Elevated
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$flag = Join-Path $root '.lab-maintenance'
$serviceName = 'LAB-Interface'
$log = Join-Path $PSScriptRoot 'service-op.log'

function Write-Step { param([string] $Text) Write-Host "  $Text" }

function Write-Log {
  param([string] $Text)
  try { "$(Get-Date -Format o)  resume: $Text" | Out-File -LiteralPath $log -Append -Encoding utf8 } catch { }
}

function Test-Elevated {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# See the long note in Lab-Interface-force-stop.ps1: PowerShell 5.1 turns a
# native tool's stderr into a terminating error while $ErrorActionPreference is
# 'Stop', so native calls go through here and are judged by their exit code.
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

# Can THIS account start, stop and reconfigure the service without elevation?
# Same probe as Lab-Interface-force-stop.ps1: read the service's security
# descriptor and look for an allow-ACE granting RP (start), WP (stop) and DC
# (change config) to a SID this token carries.
function Test-ServiceControlRights {
  if (Test-Elevated) { return $true }
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $sddl = (& sc.exe sdshow $serviceName 2>&1 | Out-String) } finally { $ErrorActionPreference = $previous }
  if (-not $sddl) { return $false }
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $mine = @($identity.User.Value) + @($identity.Groups | ForEach-Object { $_.Value })
  $wellKnown = @{ BU = 'S-1-5-32-545'; BA = 'S-1-5-32-544'; AU = 'S-1-5-11'; IU = 'S-1-5-4'; WD = 'S-1-1-0'; SY = 'S-1-5-18'; SU = 'S-1-5-6' }
  foreach ($m in [regex]::Matches($sddl, '\(A;[^;]*;([A-Z]+);;;([^)]+)\)')) {
    $rights = $m.Groups[1].Value
    $sid = $m.Groups[2].Value
    if ($wellKnown.ContainsKey($sid)) { $sid = $wellKnown[$sid] }
    if ($mine -notcontains $sid) { continue }
    $pairs = @(); for ($i = 0; $i + 1 -lt $rights.Length; $i += 2) { $pairs += $rights.Substring($i, 2) }
    if (($pairs -contains 'RP') -and ($pairs -contains 'WP') -and ($pairs -contains 'DC')) { return $true }
  }
  return $false
}

# The admin dashboard port is the one thing every copy of the connector binds,
# which makes it the reliable "is something already running" test. config.json
# is JSONC, so a comment-stripped parse is the fallback; 7071 the last resort.
function Get-ConnectorPort {
  $cfgPath = Join-Path $root 'config.json'
  if (Test-Path -LiteralPath $cfgPath) {
    $raw = Get-Content -LiteralPath $cfgPath -Raw
    foreach ($text in @($raw, [regex]::Replace($raw, '(?m)(?<![:"\w])//.*$', ''))) {
      try {
        $cfg = $text | ConvertFrom-Json
        if ($cfg.admin.port) { return [int] $cfg.admin.port }
      } catch { }
    }
  }
  return 7071
}

$svc = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if (-not $svc) {
  Write-Host ''
  Write-Step "$serviceName is not installed on this machine - nothing to resume."
  Write-Step 'Install it with service\install-service.ps1, or run the connector under PM2 with magic\magic-start.bat.'
  Write-Host ''
  exit 1
}

# ---- 0. is another connector already holding the port? ---------------------
# Checked BEFORE the flag and the watchdog are touched, so refusing here leaves
# the machine exactly as it was.
if ($svc.Status -ne 'Running') {
  $port = Get-ConnectorPort
  $listener = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($listener) {
    $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction SilentlyContinue
    $what = if ($owner) { "PID $($owner.ProcessId) ($($owner.Name))" } else { "PID $($listener.OwningProcess)" }
    $cmd = if ($owner -and $owner.CommandLine) { $owner.CommandLine } else { '(command line not visible)' }
    Write-Host ''
    Write-Step "another connector is already running and holding port ${port}: $what"
    Write-Step "  $cmd"
    Write-Step 'Not starting the service beside it - two copies would fight over the analyzer ports.'
    Write-Step 'Stop that one first (Ctrl+C in its terminal, or magic\magic-force-stop.bat), then run this again.'
    Write-Host ''
    Write-Log "refused: port $port held by $what"
    exit 1
  }
}

if (-not $Elevated -and -not (Test-ServiceControlRights)) {
  Write-Host ''
  Write-Host "  This account has no start rights on the $serviceName service -"
  Write-Host '  relaunching elevated (accept the prompt; a second window opens).'
  Write-Host '  To never see this again, run service\grant-user-control.ps1 once as administrator.'
  Write-Host ''
  try {
    $child = Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru -ErrorAction Stop `
      -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File "{0}" -Elevated' -f $PSCommandPath)
    exit $child.ExitCode
  } catch {
    Write-Host '  The administrator prompt was cancelled - the connector was NOT started.'
    Write-Host ''
    exit 1
  }
}

Write-Host ''
Write-Host ' =========================================================='
Write-Host '  LAB-Interface - resume'
Write-Host "  folder: $root"
Write-Host ' =========================================================='
Write-Host ''

# ---- 1. maintenance flag ----------------------------------------------------
if (Test-Path -LiteralPath $flag) {
  Remove-Item -LiteralPath $flag -Force -ErrorAction SilentlyContinue
  Write-Step '[1/3] maintenance flag cleared.'
} else {
  Write-Step '[1/3] no maintenance flag was set.'
}

# ---- 2. watchdog tasks ------------------------------------------------------
# Re-enable whatever the force stop disabled, under either generation of the
# name, for every operator account. Enabling a task that was never disabled is
# a no-op, so this is safe to run at any time.
$rootPattern = [regex]::Escape($root)
$tasks = @(Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object {
  $task = $_
  if ($task.TaskName -like 'Lab-Interface Watchdog*') { return $true }
  if ($task.TaskName -like 'magic Lab Connector Watchdog*') { return $true }
  foreach ($action in @($task.Actions)) {
    if (("{0} {1}" -f $action.Execute, $action.Arguments) -match $rootPattern) { return $true }
  }
  return $false
})

if ($tasks.Count -eq 0) {
  Write-Step '[2/3] watchdog: no watchdog task is registered (Lab-Interface.bat registers one).'
} else {
  foreach ($task in $tasks) {
    if ($task.State -ne 'Disabled') {
      Write-Step ("[2/3] watchdog: task ""{0}"" is already armed." -f $task.TaskName)
      continue
    }
    try {
      [void] (Enable-ScheduledTask -TaskName $task.TaskName -TaskPath $task.TaskPath -ErrorAction Stop)
      Write-Step ("[2/3] watchdog: task ""{0}"" re-enabled." -f $task.TaskName)
    } catch {
      Write-Step ("[2/3] watchdog: could NOT re-enable ""{0}"" - {1}" -f $task.TaskName, $_.Exception.Message.Trim())
    }
  }
}

# ---- 3. the service ---------------------------------------------------------
# Automatic + delayed start is what the service definition asks for: at boot,
# but only once the network stack is up, so the analyzer dials and the HMIS
# HTTPS calls do not fail on a cold boot. See service\LAB-Interface-service.xml.
$rc = Invoke-Quiet sc.exe config $serviceName start= delayed-auto
if ($rc -eq 0) {
  Write-Step '[3/3] service: start type restored to Automatic (delayed).'
} elseif ($rc -eq 5) {
  Write-Step '[3/3] service: no rights to change the start type - it stays as it is. service\grant-user-control.ps1 (once, as administrator) fixes that.'
} else {
  Write-Step ("[3/3] service: could not restore the start type (sc.exe exit {0}) - set it by hand in services.msc." -f $rc)
}

$svc.Refresh()
if ($svc.Status -eq 'Running') {
  Write-Step "[3/3] service: $serviceName is already running."
} else {
  Write-Step "[3/3] service: starting $serviceName..."
  try {
    Start-Service -Name $serviceName -ErrorAction Stop
    $svc.WaitForStatus('Running', [TimeSpan]::FromSeconds(30))
  } catch {
    Write-Step ("[3/3] service: start FAILED - {0}" -f $_.Exception.Message.Trim())
    Write-Step '       Look at logs\LAB-Interface-service.err.log - a build that does not run is the usual cause.'
    Write-Log "FAILED: $($_.Exception.Message.Trim())"
    Write-Host ''
    if ($Elevated) { Write-Host '  Press Enter to close this window.'; [void] (Read-Host) }
    exit 1
  }
}

$svc.Refresh()
Write-Host ''
Write-Host ' =========================================================='
Write-Host ("  LAB-Interface is {0}." -f $svc.Status)
Write-Host '  Dashboard: http://127.0.0.1:7071'
Write-Host '  Logs     : logs\LAB-Interface-service.out.log'
Write-Host ' =========================================================='
Write-Host ''
Write-Log "OK, service $($svc.Status)"
if ($Elevated) { Write-Host '  Press Enter to close this window.'; [void] (Read-Host) }
exit 0
