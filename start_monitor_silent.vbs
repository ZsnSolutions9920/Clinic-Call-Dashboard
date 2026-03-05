' Launches call_monitor.ps1 hidden (no window flash)
' Place this file in shell:startup to auto-run on Windows login
Set objShell = CreateObject("WScript.Shell")
objShell.Run "powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & Replace(WScript.ScriptFullName, WScript.ScriptName, "") & "call_monitor.ps1""", 0, False
