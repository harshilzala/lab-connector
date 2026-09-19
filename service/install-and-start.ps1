# Elevated, one UAC prompt: install the LAB-Interface Windows service, then
# wait for the PM2-run copy to be taken down (the admin port 7071 goes free),
# then start the service. Everything is logged so the non-elevated session
# can follow the result in service-op.log.
#
# Run it via:  Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File "C:\lab\lab-connector\service\install-and-start.ps1"'
$log = 'C:\lab\lab-connector\service\service-op.log'
"==== install+start $(Get-Date -Format o) ====" | Out-File $log -Append -Encoding utf8
try {
  Set-Location 'C:\lab\lab-connector\service'

  $svc = Get-Service -Name LAB-Interface -ErrorAction SilentlyContinue
  if ($null -eq $svc) {
    (& '.\LAB-Interface-service.exe' install 2>&1 | Out-String) | Out-File $log -Append -Encoding utf8
  } else {
    "service already installed (status $($svc.Status)) - skipping install" | Out-File $log -Append -Encoding utf8
  }
  (& sc.exe config LAB-Interface start= delayed-auto 2>&1 | Out-String) | Out-File $log -Append -Encoding utf8
  "INSTALL_RESULT=OK" | Out-File $log -Append -Encoding utf8

  # Wait (up to 3 minutes) for the PM2 copy to release the dashboard port.
  $deadline = (Get-Date).AddMinutes(3)
  $busy = $true
  while ((Get-Date) -lt $deadline) {
    $busy = $null -ne (Get-NetTCPConnection -LocalPort 7071 -State Listen -ErrorAction SilentlyContinue)
    if (-not $busy) { break }
    Start-Sleep -Seconds 2
  }
  if ($busy) {
    "START_RESULT=SKIPPED: port 7071 still in use after 3 minutes (PM2 copy still running). Start later with start-service.ps1" | Out-File $log -Append -Encoding utf8
    exit 2
  }

  (& sc.exe start LAB-Interface 2>&1 | Out-String) | Out-File $log -Append -Encoding utf8
  Start-Sleep -Seconds 8
  (& sc.exe query LAB-Interface 2>&1 | Out-String) | Out-File $log -Append -Encoding utf8
  "START_RESULT=OK" | Out-File $log -Append -Encoding utf8
} catch {
  "RESULT=ERROR: $($_.Exception.Message)" | Out-File $log -Append -Encoding utf8
  exit 1
}
