' ===========================================================================
'  magic-startup-hidden  -  invisible launcher for magic-startup.cmd.
'
'  The logon entry and the 5-minute watchdog run in the operator's own
'  session, so a .cmd started directly gets a console window - a black box
'  flashing on the lab PC's screen at every logon and every 5 minutes. This
'  runs the same .cmd with window style 0: same account, same session, same
'  work, no window.
'
'  The exit code is passed through (bWaitOnReturn = True) so Task Scheduler's
'  "Last Run Result" still says whether the start worked.
'
'  Windows Script Host is policy-blocked on some hospital machines. When it
'  is, magic-add-to-startup.bat registers the .cmd directly (minimised, but
'  visible) - a visible watchdog beats none on unattended lab equipment.
' ===========================================================================
Option Explicit

Dim shell, fso, here, target, rc

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)
target = fso.BuildPath(here, "magic-startup.cmd")

If Not fso.FileExists(target) Then
  ' Nothing to launch - report it rather than look like a clean run.
  WScript.Quit 2
End If

shell.CurrentDirectory = here

' 0    = hidden window
' True = wait, so the .cmd's exit code becomes this script's exit code
rc = shell.Run("""" & target & """", 0, True)

WScript.Quit rc
