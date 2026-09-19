# Elevated: start the LAB-Interface Windows service and report status.
$log = 'C:\lab\lab-connector\service\service-op.log'
"==== start $(Get-Date -Format o) ====" | Out-File $log -Append -Encoding utf8
try {
  (& sc.exe start LAB-Interface 2>&1 | Out-String) | Out-File $log -Append -Encoding utf8
  Start-Sleep -Seconds 6
  (& sc.exe query LAB-Interface 2>&1 | Out-String) | Out-File $log -Append -Encoding utf8
  "START_RESULT=OK" | Out-File $log -Append -Encoding utf8
} catch {
  "START_RESULT=ERROR: $($_.Exception.Message)" | Out-File $log -Append -Encoding utf8
  exit 1
}
