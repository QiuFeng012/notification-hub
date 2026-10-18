' Notification Hub - autostart (silent warm-up) wrapper
'
' Why this layer exists: same reason as launch-app.vbs. The server's node
' process inherits the caller's console handles; a hidden powershell started
' directly makes Windows think the parent still has a console child, so the
' parent hangs at process creation and the service never starts. wscript has
' no console to inherit, so it can quietly warm the service up.
'
' This wrapper only ENSURES the service is running; it never opens a window.
'
' Usage (invoked by the Startup-folder shortcut, not double-clicked):
'   wscript.exe scripts\autostart.vbs
Option Explicit

Dim shell, fso, baseDir, scriptPath, command
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' This file lives under scripts\, so the project root is its parent.
baseDir = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
scriptPath = fso.BuildPath(baseDir, "scripts\launch-app.ps1")

If Not fso.FileExists(scriptPath) Then
  MsgBox "Launch script not found: " & scriptPath, 16, "Notification Hub"
  WScript.Quit 1
End If

' -NoLaunch: ensure the service is running, but do not open an app window.
command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & scriptPath & """ -NoLaunch"

' 0 = hidden window, False = do not wait for it to finish.
shell.Run command, 0, False
