' ===========================================================================
'  Lab-Interface - invisible launcher for the 5-minute watchdog.
'
'  WHY THIS FILE EXISTS
'  The watchdog scheduled task used to run Lab-Interface-startup.cmd
'  directly. That task runs in the logged-on user's own session, so Windows
'  gave it a console window - a black box flashing on the lab PC's screen
'  every 5 minutes, all day. The script itself is fine and usually exits in
'  well under a second; only the window was the problem.
'
'  WScript.Shell.Run with window style 0 starts the same .cmd with no window
'  at all, in the same session and under the same account, so nothing about
'  what the watchdog DOES changes - it just stops being visible.
'
'  The exit code is passed through (bWaitOnReturn = True) so Task Scheduler's
'  "Last Run Result" still reports whether the keep-alive worked.
'
'  Windows Script Host is disabled by policy on some hospital machines. If it
'  ever is here, Lab-Interface.bat falls back to registering the .cmd
'  directly - visible, but working. Never trade the keep-alive for quiet.
' ===========================================================================
Option Explicit

Dim shell, fso, here, target, rc

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)
target = fso.BuildPath(here, "Lab-Interface-startup.cmd")

If Not fso.FileExists(target) Then
  ' Nothing to launch. Report a non-zero result so the task history shows it
  ' rather than looking like a clean run that quietly did nothing.
  WScript.Quit 2
End If

shell.CurrentDirectory = here

' 0    = hidden window
' True = wait, so the .cmd's exit code becomes this script's exit code
rc = shell.Run("""" & target & """", 0, True)

WScript.Quit rc
