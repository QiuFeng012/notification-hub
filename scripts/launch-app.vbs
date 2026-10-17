' Notification Hub - windowless launcher wrapper
'
' Why this layer exists:
'   The server's node process inherits the caller's console handles. Launching
'   the launcher directly via "powershell -WindowStyle Hidden" makes Windows
'   think the parent still has a console child running, so the parent hangs at
'   process creation and the service never starts. Confirmed empirically:
'   Start-Process, cmd start /b, and System.Diagnostics.Process all hang alike.
'
'   This VBScript runs under wscript, which has no console to inherit, and
'   WScript.Shell.Run hands process creation to Windows, so the launcher can
'   quietly bring up the service in the background without flashing a window.
'
' Usage (invoked by the desktop shortcut, not double-clicked directly):
'   wscript.exe scripts\launch-app.vbs
'
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

command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & scriptPath & """"

' 0 = hidden window, False = do not wait for it to finish.
' Not waiting is required: the launcher takes a few seconds to pass its health
' check, and this wrapper has no reason to wait for it.
shell.Run command, 0, False
