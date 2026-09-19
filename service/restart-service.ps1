# Elevated: restart the LAB-Interface Windows service after a redeploy.
#
#   1. npm run build            (as the normal user, in C:\lab\lab-connector)
#   2. right-click this file -> Run with PowerShell   (answers the UAC prompt)
#
# Or from a non-elevated shell:
#   Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File "C:\lab\lab-connector\service\restart-service.ps1"'
#
# The service stops the connector gracefully (sockets closed, spool flushed,
# see <stoptimeout> in LAB-Interface-service.xml) and starts the freshly built
# dist\index.js. Everything is logged to service-op.log for the non-elevated
# session to read.
$log = 'C:\lab\lab-connector\service\service-op.log'
"==== restart $(Get-Date -Format o) ====" | Out-File $log -Append -Encoding utf8
try {
  (& sc.exe stop LAB-Interface 2>&1 | Out-String) | Out-File $log -Append -Encoding utf8
  $deadline = (Get-Date).AddSeconds(30)
  while ((Get-Date) -lt $deadline -and (Get-Service LAB-Interface).Status -ne 'Stopped') { Start-Sleep -Seconds 1 }
  (& sc.exe start LAB-Interface 2>&1 | Out-String) | Out-File $log -Append -Encoding utf8
  Start-Sleep -Seconds 6
  (& sc.exe query LAB-Interface 2>&1 | Out-String) | Out-File $log -Append -Encoding utf8
  "RESTART_RESULT=OK" | Out-File $log -Append -Encoding utf8
} catch {
  "RESTART_RESULT=ERROR: $($_.Exception.Message)" | Out-File $log -Append -Encoding utf8
  exit 1
}
