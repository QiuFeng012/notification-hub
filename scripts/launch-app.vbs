' 信息整合台 —— 无窗口启动包装器
'
' 为什么需要这一层：
'   服务的 node 进程会继承调用方的控制台句柄。如果直接用
'   powershell -WindowStyle Hidden 去启动启动器，Windows 会认为
'   "父进程还有控制台子进程在跑"，于是父进程卡在创建进程那一步不返回，
'   服务永远起不来。实测确认：Start-Process、cmd start /b、
'   System.Diagnostics.Process 三种写法都一样卡。
'
'   这个 VBScript 由 wscript 执行：它没有控制台可继承，
'   而且 WScript.Shell.Run 是交给 Windows 去创建进程，
'   所以启动器可以安安静静在后台把服务拉起来，不闪任何窗口。
'
' 用法（由桌面快捷方式调用，不直接双击）：
'   wscript.exe scripts\launch-app.vbs
'
Option Explicit

Dim shell, fso, baseDir, scriptPath, command
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' 本文件在 scripts\ 下，项目根目录是它的上一级
baseDir = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
scriptPath = fso.BuildPath(baseDir, "scripts\launch-app.ps1")

If Not fso.FileExists(scriptPath) Then
  MsgBox "找不到启动脚本：" & scriptPath, 16, "信息整合台"
  WScript.Quit 1
End If

command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & scriptPath & """"

' 0 = 隐藏窗口，False = 不等它结束。
' 不等是必须的：启动器要用几秒钟等健康检查通过，包装器没必要陪它等。
shell.Run command, 0, False
