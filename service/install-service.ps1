# Elevated: install the LAB-Interface Windows service (does NOT start it).
# Runs under an admin token via UAC. Logs everything so the non-elevated
# session can read the result.
$log = 'C:\lab\lab-connector\service\service-op.log'
"==== install $(Get-Date -Format o) ====" | Out-File $log -Encoding utf8
try {
  Set-Location 'C:\lab\lab-connector\service'
  (& '.\LAB-Interface-service.exe' install 2>&1 | Out-String) | Out-File $log -Append -Encoding utf8
  (& sc.exe config LAB-Interface start= delayed-auto 2>&1 | Out-String) | Out-File $log -Append -Encoding utf8
  (& sc.exe query LAB-Interface 2>&1 | Out-String) | Out-File $log -Append -Encoding utf8
  "INSTALL_RESULT=OK" | Out-File $log -Append -Encoding utf8
} catch {
  "INSTALL_RESULT=ERROR: $($_.Exception.Message)" | Out-File $log -Append -Encoding utf8
  exit 1
}
