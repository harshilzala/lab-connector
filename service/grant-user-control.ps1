<#
  LAB-Interface - let ordinary operators control the Windows service.

  Run ONCE per machine, as administrator (it relaunches itself elevated - one
  UAC prompt). After it, none of the day-to-day scripts need "Run as
  administrator" any more:

    magic\magic-start.bat / Lab-Interface.bat   -> service\resume-service.ps1
    magic\magic-stop.bat                         -> sc stop
    magic\magic-force-stop.bat / Lab-Interface-force-stop.bat
    magic\magic-startup.cmd (logon entry + 5-minute watchdog) -> sc start

  Why this is needed
  ------------------
  Windows lets only Administrators (and SYSTEM) start, stop or reconfigure a
  service, by default. A LocalSystem service is exactly what makes the connector
  come up at the login screen with nobody signed in, so we want to keep it - but
  the lab operators are standard users, and every start/stop was costing a UAC
  prompt for a password they do not have.

  The Service Control Manager keeps a security descriptor per service. Adding an
  allow-ACE for BUILTIN\Users (S-1-5-32-545) to the LAB-Interface service is a
  supported, permanent, per-service grant. It gives standard users, on this one
  service only:

    RP  start                      WP  stop
    DT  pause / continue           DC  change config (start type)
    CC  query config               LC  query status
    SW  enumerate dependents       LO  interrogate
    CR  user-defined control       RC  read the security descriptor

  It deliberately does NOT grant SD (delete the service), WD (change its
  security) or WO (take ownership). DC is included so magic-stop.bat can set the
  start type to Manual (so a deliberate stop survives a reboot) and
  resume-service.ps1 can set it back to Automatic (delayed).

  Idempotent: re-running it when the grant is already in place changes nothing.
  Everything is logged to service-op.log so the non-elevated window can see the
  result.
#>
[CmdletBinding()]
param(
  # Set by the script on its own elevated relaunch; keeps that window open.
  [switch] $Elevated
)

$ErrorActionPreference = 'Stop'
$serviceName = 'LAB-Interface'
$log = Join-Path $PSScriptRoot 'service-op.log'
$usersSid = 'BU'
$usersAce = "(A;;CCDCLCSWRPWPDTLOCRRC;;;$usersSid)"

function Write-Step { param([string] $Text) Write-Host "  $Text" }
function Write-Log {
  param([string] $Text)
  try { "$(Get-Date -Format o)  grant: $Text" | Out-File -LiteralPath $log -Append -Encoding utf8 } catch { }
}
function Test-Elevated {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}
function Get-Sddl {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { return ((& sc.exe sdshow $serviceName 2>&1 | Out-String).Trim()) }
  finally { $ErrorActionPreference = $previous }
}
function Finish {
  param([int] $Code)
  Write-Host ''
  if ($Elevated) { Write-Host '  Press Enter to close this window.'; [void] (Read-Host) }
  exit $Code
}

if (-not (Get-Service -Name $serviceName -ErrorAction SilentlyContinue)) {
  Write-Host ''
  Write-Step "$serviceName is not installed on this machine - nothing to grant."
  Write-Step 'Install it first with service\install-and-start.ps1 (or run the connector under PM2, which needs no grant).'
  Write-Log 'skipped: service not installed'
  Finish 1
}

if (-not $Elevated -and -not (Test-Elevated)) {
  Write-Host ''
  Write-Host "  Changing the $serviceName service's security needs administrator rights -"
  Write-Host '  relaunching elevated (accept the prompt; a second window opens). This is a ONE-TIME step.'
  Write-Host ''
  try {
    $child = Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru -ErrorAction Stop `
      -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File "{0}" -Elevated' -f $PSCommandPath)
    exit $child.ExitCode
  } catch {
    Write-Host '  The administrator prompt was cancelled - nothing was changed.'
    Write-Host ''
    exit 1
  }
}

Write-Host ''
Write-Host ' =========================================================='
Write-Host "  $serviceName - grant start/stop/config to BUILTIN\Users"
Write-Host ' =========================================================='
Write-Host ''
Write-Log 'begin'

$sddl = Get-Sddl
if (-not $sddl.StartsWith('D:')) {
  Write-Step "could not read the service's security descriptor: $sddl"
  Write-Log "FAILED: sdshow -> $sddl"
  Finish 1
}
Write-Step "current : $sddl"

# Already granted? Look for a BU allow-ACE that carries start, stop and config.
$have = $false
foreach ($m in [regex]::Matches($sddl, "\(A;[^;]*;([A-Z]+);;;$usersSid\)")) {
  $rights = $m.Groups[1].Value
  $pairs = @(); for ($i = 0; $i + 1 -lt $rights.Length; $i += 2) { $pairs += $rights.Substring($i, 2) }
  if (($pairs -contains 'RP') -and ($pairs -contains 'WP') -and ($pairs -contains 'DC')) { $have = $true }
}

if ($have) {
  Write-Step 'BUILTIN\Users already has start/stop/config rights - nothing to do.'
  Write-Log 'already granted'
  Finish 0
}

# Insert our ACE at the end of the DACL (before any S: SACL part).
$sacl = ''
$dacl = $sddl
$sIdx = $sddl.IndexOf('S:')
if ($sIdx -gt 0) { $dacl = $sddl.Substring(0, $sIdx); $sacl = $sddl.Substring($sIdx) }
$new = $dacl + $usersAce + $sacl
Write-Step "applying: $new"

$previous = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try { $out = (& sc.exe sdset $serviceName $new 2>&1 | Out-String).Trim(); $rc = $LASTEXITCODE }
finally { $ErrorActionPreference = $previous }
if ($rc -ne 0) {
  Write-Step "sc sdset failed (exit $rc): $out"
  Write-Log "FAILED: sdset exit $rc - $out"
  Finish 1
}

$after = Get-Sddl
Write-Step "now     : $after"
if ($after -like "*;;;$usersSid)*") {
  Write-Host ''
  Write-Step 'Done. Standard users can now start, stop and reconfigure the service.'
  Write-Step 'The magic\ and Lab-Interface-* scripts will no longer ask for administrator rights.'
  Write-Log "OK: $after"
  Finish 0
}
Write-Step 'the grant did not show up in the descriptor afterwards - see the lines above.'
Write-Log "FAILED: verify -> $after"
Finish 1
