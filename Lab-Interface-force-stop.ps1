<#
  Lab-Interface - force stop (engine).

  Run Lab-Interface-force-stop.bat instead of this file unless you want the
  switches below; the .bat is the double-clickable wrapper.

  Why this exists next to Lab-Interface-stop.bat
  ------------------------------------------------
  Lab-Interface-stop.bat only knows how to stop the connector when PM2 is
  managing it. If someone ever started it straight from a console -

      node dist/index.js

  - then PM2 has no entry for it, the stop script prints "not registered with
  PM2 - nothing to stop", and the connector keeps running: still bound to the
  analyzer ports, still posting to HMIS. That is exactly the situation this
  script is for. It stops the connector however it was started.

  What it does, in order
  ----------------------
    1. Raises the .lab-maintenance flag, so a watchdog tick landing in the
       middle of the stop does not start it again. Same flag, same meaning as
       Lab-Interface-stop.bat: it stays down until Lab-Interface.bat runs.
    2. Stops the PM2 apps if PM2 has them (SIGTERM, kill_timeout 8s to flush),
       under the current name and the retired "GENEX-Interface" / "lab-connector"
       pm2 save, so a logon does not resurrect it.
    3. Sweeps up anything still running: node.exe processes on this project's
       compiled entry point, plus whatever is holding the admin dashboard port.
       Each one is asked to close first, and only killed hard if it is still
       there after -GraceSeconds.
    4. Verifies nothing is left, and says so.

  Analyzer results already written to .\spool stay on disk and are delivered
  when the connector next starts - stopping never loses them.

  Exit code 0 = nothing is running any more. 1 = something survived (the
  message says what).
#>
[CmdletBinding()]
param(
  # How long a process gets to close on its own before it is killed hard.
  [int] $GraceSeconds = 12,

  # Stop without raising .lab-maintenance. The watchdog will then start the
  # connector again within 5 minutes - only useful for a deliberate bounce.
  [switch] $KeepWatchdogArmed
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$flag = Join-Path $root '.lab-maintenance'

# Same PM2 home as Lab-Interface.bat - beside the connector, writable by every
# operator - so this script stops the connector without "Run as administrator".
# The machine-wide C:\ProgramData\pm2\home is owned by the LocalSystem PM2
# service and grants Users read only, which made every unelevated pm2 call fail
# with EPERM on pm2.pid. See the long note in Lab-Interface.bat.
$env:PM2_HOME = Join-Path $root '.pm2'

function Write-Step { param([string] $Text) Write-Host "  $Text" }

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
  #    different command line, and confirms the ones found above.
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
  Write-Step ("PID {0} - {1}" -f $procId, $Proc.CommandLine)

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
    # process belongs to somebody else - most often the LocalSystem "PM2"
    # service started it, in which case only an elevated session can end it.
    Write-Step ("PID {0} SURVIVED - it is owned by another account (often the LocalSystem PM2 service); only an elevated session can stop that one." -f $procId)
    return $false
  }

  Write-Step ("PID {0} stopped." -f $procId)
  return $true
}

Write-Host ''
Write-Host ' =========================================================='
Write-Host '  Lab-Interface - force stop'
Write-Host "  folder: $root"
Write-Host ' =========================================================='
Write-Host ''

# ---- 1. maintenance flag, before anything is stopped ------------------------
if ($KeepWatchdogArmed) {
  Write-Step '[1/4] maintenance flag NOT raised (-KeepWatchdogArmed): the watchdog may start it again within 5 minutes.'
} else {
  "Stopped by Lab-Interface-force-stop.ps1 on $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" |
    Set-Content -LiteralPath $flag -Encoding ASCII
  Write-Step '[1/4] maintenance flag raised - the watchdog will leave it alone.'
}

# ---- 2. PM2 ----------------------------------------------------------------
$pm2 = Get-Command 'pm2.cmd', 'pm2' -CommandType Application -ErrorAction SilentlyContinue |
  Select-Object -First 1
$pm2Managed = $false

if ($pm2) {
  foreach ($app in 'Lab-Interface', 'GENEX-Interface', 'lab-connector') {
    $describeExit = Invoke-Quiet $pm2.Source describe $app
    if ($describeExit -eq 0) {
      $pm2Managed = $true
      Write-Step "[2/4] PM2: stopping $app (SIGTERM, up to 8s to flush the spool)..."
      [void] (Invoke-Quiet $pm2.Source stop $app)
      [void] (Invoke-Quiet $pm2.Source save)
      Write-Step "[2/4] PM2: $app stopped, and the stopped state saved."
    }
  }
  if (-not $pm2Managed) { Write-Step '[2/4] PM2 has no Lab-Interface entry - nothing to stop there.' }
} else {
  Write-Step '[2/4] PM2 is not on PATH - skipping the PM2 stop.'
}

# ---- 3. sweep --------------------------------------------------------------
$targets = @(Get-ConnectorProcess)
if ($targets.Count -eq 0) {
  Write-Step '[3/4] no connector process is running.'
} else {
  Write-Step ("[3/4] {0} connector process(es) still running:" -f $targets.Count)
  foreach ($target in $targets) { [void] (Stop-ConnectorProcess -Proc $target) }
}

# ---- 4. verify -------------------------------------------------------------
Start-Sleep -Milliseconds 500
$left = @(Get-ConnectorProcess)

Write-Host ''
if ($left.Count -eq 0) {
  Write-Step '[4/4] verified: nothing is listening, nothing is running.'
  Write-Host ''
  Write-Host ' =========================================================='
  if ($KeepWatchdogArmed) {
    Write-Host '  Lab-Interface is stopped. The watchdog is still armed,'
    Write-Host '  so it will come back within 5 minutes.'
  } else {
    Write-Host '  Lab-Interface is stopped and will STAY stopped.'
    Write-Host '  Start it again with Lab-Interface.bat'
  }
  Write-Host ' =========================================================='
  Write-Host ''
  exit 0
}

Write-Step ("[4/4] STILL RUNNING: PID(s) {0}." -f (($left | ForEach-Object { $_.ProcessId }) -join ', '))
if ($pm2Managed) {
  Write-Step 'PM2 started it again. Run this script once more, or remove the entry with: pm2 delete Lab-Interface'
} elseif (-not $pm2) {
  Write-Step 'PM2 was not on PATH: if PM2 owns this process it will keep restarting it.'
  Write-Step 'Open a console where "pm2 list" works and run this script from there.'
} else {
  Write-Step 'The process belongs to another account. If the machine-wide "PM2" service (LocalSystem) started it, stop it from an elevated prompt: sc.exe stop pm2.exe'
}
Write-Host ''
exit 1
